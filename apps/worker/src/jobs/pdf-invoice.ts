// ════════════════════════════════════════════════════════════════════
// apps/worker/src/jobs/pdf-invoices.ts
//
// Background PDF-invoice generation (BullMQ queue: "pdf-invoice").
//
// The page layout now comes from the SHARED renderer renderInvoicePdf()
// — the exact same one apps/api uses — so a worker-generated invoice is
// byte-for-byte identical to an app-generated one. The old hand-rolled
// layout in this file (which had the WRONG company GSTIN) is gone.
//
// Adjust the import path to wherever render-invoice-pdf.ts lives. The
// recommended setup is a shared workspace package (@hmu/invoicing); if
// you instead copied the renderer into the worker, import it from
// "../lib/render-invoice-pdf.js".
// ════════════════════════════════════════════════════════════════════
import type { JobLike } from "../lib/queues.js";
import { sql } from "../lib/db.js";
import { uploadPDF } from "../lib/r2.js";
import {
  renderInvoicePdf,
  type InvoiceRenderLine,
} from "../lib/render-invoice-pdf.js";

export interface PDFInvoiceJobData {
  orderId: string;
}

export async function processPDFInvoice(job: JobLike<PDFInvoiceJobData>) {
  const { orderId } = job.data;

  // ── Fetch order + dealer + route ───────────────────────────────────
  const [order] = await sql`
    SELECT
      o.id, o.subtotal, o.total_gst, o.grand_total, o.payment_mode,
      o.status, o.created_at,
      COALESCE(o.delivery_date, (o.created_at AT TIME ZONE 'Asia/Kolkata')::date)
        AS order_date,
      d.id          AS dealer_id,
      d.code        AS dealer_code,
      d.name        AS dealer_name,
      d.phone       AS dealer_phone,
      d.gst_number  AS dealer_gst,
      d.address     AS dealer_address,
      d.city        AS dealer_city,
      d.state       AS dealer_state,
      d.pin_code    AS dealer_pin,
      r.code        AS route_code,
      r.name        AS route_name
    FROM orders o
    JOIN dealers d      ON d.id = o.dealer_id
    LEFT JOIN routes r  ON r.id = COALESCE(o.route_id, d.route_id)
    WHERE o.id = ${orderId}
    LIMIT 1
  `;
  if (!order) throw new Error(`Order ${orderId} not found`);

  // ── Line items ─────────────────────────────────────────────────────
  const rawItems = await sql`
    SELECT
      oi.product_name                          AS product_name,
      COALESCE(p.hsn_no, '')                   AS hsn_no,
      COALESCE(p.pack_size::text, '')          AS pack_size,
      oi.quantity                              AS quantity,
      oi.unit_price                            AS unit_price,
      (oi.gst_amount / 2)::numeric(10,2)       AS cgst_amount,
      (oi.gst_amount / 2)::numeric(10,2)       AS sgst_amount,
      oi.line_total                            AS line_total,
      (oi.quantity * oi.unit_price)::numeric(10,2) AS basic
    FROM order_items oi
    LEFT JOIN products p ON p.id = oi.product_id
    WHERE oi.order_id = ${orderId}
    ORDER BY oi.product_name
  `;

  const items: InvoiceRenderLine[] = rawItems.map((it: any) => ({
    productName: it.product_name,
    hsnNo: it.hsn_no ?? "",
    packSize: it.pack_size ?? "",
    quantity: Number(it.quantity ?? 0),
    unitPrice: parseFloat(it.unit_price ?? "0"),
    basic: parseFloat(it.basic ?? "0"),
    cgstAmount: parseFloat(it.cgst_amount ?? "0"),
    sgstAmount: parseFloat(it.sgst_amount ?? "0"),
    lineTotal: parseFloat(it.line_total ?? "0"),
  }));

  // ── Dates + numbering ──────────────────────────────────────────────
  const deliveryDate = new Date(order.order_date);
  const issueDate = new Date();
  const invoiceNumber =
    `INV-HMU-${deliveryDate.getFullYear()}-` + orderId.slice(0, 8).toUpperCase();

  // ── Totals ─────────────────────────────────────────────────────────
  const taxable = items.reduce((s, l) => s + l.basic, 0);
  const totalGst = parseFloat(order.total_gst ?? "0");
  const cgst = totalGst / 2;
  const sgst = totalGst / 2;
  const grand = parseFloat(order.grand_total ?? "0");
  const netAmount = Math.round(grand);

  // ── Render via the shared layout ───────────────────────────────────
  // A placed order is settled — by wallet/UPI/cash up front or on the
  // dealer's credit ledger (incl. auto-confirm) — so its invoice is "PAID".
  const paid = ["confirmed", "dispatched", "delivered"].includes(order.status);

  const pdfBytes = await renderInvoicePdf({
    invoiceNumber,
    issueDate,
    deliveryDate,
    orderId,
    paymentMode: order.payment_mode || "Wallet",
    paid,
    dealer: {
      name: order.dealer_name,
      code: order.dealer_code,
      address: order.dealer_address,
      city: order.dealer_city,
      state: order.dealer_state,
      pin: order.dealer_pin,
      phone: order.dealer_phone,
      gst: order.dealer_gst,
    },
    route: { name: order.route_name, code: order.route_code },
    items,
    totals: { taxable, cgst, sgst, grand },
  });

  // ── Upload to R2 ───────────────────────────────────────────────────
  const key = `invoices/${deliveryDate.getFullYear()}/${invoiceNumber}.pdf`;
  let pdfUrl: string | null = null;
  try {
    pdfUrl = await uploadPDF(key, pdfBytes);
  } catch (err) {
    console.warn(`[PDF] R2 upload failed for ${invoiceNumber}:`, err);
  }

  // ── Persist invoice record — both dates; issue date set once ───────
  const addressSnapshot =
    [order.dealer_address, order.dealer_city, order.dealer_pin]
      .filter(Boolean)
      .join(", ") || null;

  await sql`
    INSERT INTO invoices (
        order_id, dealer_id, invoice_number,
        invoice_date, delivery_date,
        taxable_amount, cgst, sgst, total_tax, total_amount,
        dealer_name, dealer_gst_number, dealer_address,
        pdf_url, pdf_generated_at
    ) VALUES (
        ${orderId}, ${order.dealer_id}, ${invoiceNumber},
        now(), ${order.order_date}::date,
        ${taxable.toFixed(2)}::numeric, ${cgst.toFixed(2)}::numeric,
        ${sgst.toFixed(2)}::numeric, ${totalGst.toFixed(2)}::numeric,
        ${netAmount.toFixed(2)}::numeric,
        ${order.dealer_name}, ${order.dealer_gst || null}, ${addressSnapshot},
        ${pdfUrl}, now()
    )
    ON CONFLICT (order_id) DO UPDATE
        SET pdf_url          = EXCLUDED.pdf_url,
            delivery_date    = EXCLUDED.delivery_date,
            taxable_amount   = EXCLUDED.taxable_amount,
            cgst             = EXCLUDED.cgst,
            sgst             = EXCLUDED.sgst,
            total_tax        = EXCLUDED.total_tax,
            total_amount     = EXCLUDED.total_amount,
            pdf_generated_at = now()
  `;

  console.log(
    `[PDF] Generated ${invoiceNumber} for order ${orderId.slice(0, 8)} → ${
      pdfUrl || "local only"
    }`
  );

  return { invoiceNumber, pdfUrl, orderId };
}