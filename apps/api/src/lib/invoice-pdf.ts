// ════════════════════════════════════════════════════════════════════
// apps/api/src/lib/invoice-pdf.ts
//
// Generates the dealer-facing PDF tax invoice on the API side (called
// synchronously from POST /orders and the "View Invoice" endpoint).
//
// The actual page layout lives in the shared renderer renderInvoicePdf()
// so the API and the worker produce byte-for-byte identical invoices.
// This file is only responsible for:
//   1. fetching order + dealer + route + line items from the DB,
//   2. calling the shared renderer,
//   3. uploading to R2 (optional),
//   4. persisting the invoices row (both dates: issue + delivery).
//
// Adjust the import path below to wherever render-invoice-pdf.ts lives
// (a shared @hmu/invoicing package is recommended).
// ════════════════════════════════════════════════════════════════════
import { pgClient } from "./db.js";
import {
  renderInvoicePdf,
  type InvoiceRenderLine,
} from "./render-invoice-pdf.js";

export interface InvoicePdfResult {
  pdfUrl: string | null;
  pdfBytes: Uint8Array;
  invoiceNumber: string;
}

export async function generateInvoicePdfSync(
  orderId: string
): Promise<InvoicePdfResult> {
  // ── Fetch order + dealer + route ───────────────────────────────────
  const [order] = await pgClient`
    SELECT
      o.id, o.subtotal, o.total_gst, o.grand_total, o.payment_mode,
      o.status, o.created_at,
      -- delivery_date is the date the indent is FOR (migration 0031);
      -- fall back to created_at for any historical row missing it.
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

  // ── Line items — same shape the admin invoice-detail endpoint uses ─
  const rawItems = await pgClient`
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

  // ── Dates: delivery date drives the invoice number year (stable);
  //    issue date is the legal date of issue, fixed at first generation.
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

  // ── Render ─────────────────────────────────────────────────────────
  // A placed order is settled — whether by wallet/UPI/cash up front or on
  // the dealer's credit ledger (incl. auto-confirm). All such invoices carry
  // a "PAID" mark; an unplaced order never reaches invoice generation.
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

  // ── R2 upload (optional) ───────────────────────────────────────────
  let pdfUrl: string | null = null;
  try {
    pdfUrl = await tryUploadR2(
      `invoices/${deliveryDate.getFullYear()}/${invoiceNumber}.pdf`,
      pdfBytes
    );
  } catch (err) {
    console.warn("[invoice] R2 upload failed:", err);
  }

  // ── Persist — stores BOTH dates. invoice_date (legal issue date) is
  //    set once and intentionally NOT updated on regeneration.
  const addressSnapshot =
    [order.dealer_address, order.dealer_city, order.dealer_pin]
      .filter(Boolean)
      .join(", ") || null;

  await pgClient`
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

  return { pdfUrl, pdfBytes, invoiceNumber };
}

/**
 * Employee-indent tax invoice.
 *
 * The dealer path above can't be reused directly: an employee indent lives in
 * employee_orders / employee_order_items and its party is an employees row, so
 * every join differs. Everything downstream — the rendered layout, the invoice
 * number scheme, the R2 key, the upsert on order_id — is deliberately
 * identical, so an employee invoice is indistinguishable from a dealer one to
 * the reader and to the invoice list.
 *
 * invoices.dealer_id is NULL here and employee_id carries the party
 * (migration 0062, enforced by invoices_party_chk). dealer_name still holds
 * the party name for both kinds, which is what keeps the existing invoice
 * reports working unchanged.
 */
export async function generateEmployeeInvoicePdfSync(
  employeeOrderId: string
): Promise<InvoicePdfResult> {
  const [order] = await pgClient`
    SELECT
      eo.id, eo.subtotal, eo.total_gst, eo.grand_total, eo.payment_mode,
      eo.status, eo.created_at,
      COALESCE(eo.delivery_date, (eo.created_at AT TIME ZONE 'Asia/Kolkata')::date)
        AS order_date,
      e.id            AS employee_id,
      e.employee_code AS dealer_code,
      e.name          AS dealer_name,
      e.phone         AS dealer_phone,
      r.code          AS route_code,
      r.name          AS route_name
    FROM employee_orders eo
    JOIN employees e   ON e.id = eo.employee_id
    LEFT JOIN routes r ON r.id = eo.route_id
    WHERE eo.id = ${employeeOrderId}
    LIMIT 1
  `;
  if (!order) throw new Error(`Employee order ${employeeOrderId} not found`);

  const rawItems = await pgClient`
    SELECT
      eoi.product_name                          AS product_name,
      COALESCE(p.hsn_no, '')                    AS hsn_no,
      COALESCE(p.pack_size::text, '')           AS pack_size,
      eoi.quantity                              AS quantity,
      eoi.unit_price                            AS unit_price,
      (eoi.gst_amount / 2)::numeric(10,2)       AS cgst_amount,
      (eoi.gst_amount / 2)::numeric(10,2)       AS sgst_amount,
      eoi.line_total                            AS line_total,
      (eoi.quantity * eoi.unit_price)::numeric(10,2) AS basic
    FROM employee_order_items eoi
    LEFT JOIN products p ON p.id = eoi.product_id
    WHERE eoi.employee_order_id = ${employeeOrderId}
    ORDER BY eoi.product_name
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

  const deliveryDate = new Date(order.order_date);
  const issueDate = new Date();
  const invoiceNumber =
    `INV-HMU-${deliveryDate.getFullYear()}-` + employeeOrderId.slice(0, 8).toUpperCase();

  const taxable = items.reduce((s, l) => s + l.basic, 0);
  const totalGst = parseFloat(order.total_gst ?? "0");
  const cgst = totalGst / 2;
  const sgst = totalGst / 2;
  const grand = parseFloat(order.grand_total ?? "0");
  const netAmount = Math.round(grand);

  const paid = ["confirmed", "dispatched", "delivered"].includes(order.status);

  const pdfBytes = await renderInvoicePdf({
    invoiceNumber,
    issueDate,
    deliveryDate,
    orderId: employeeOrderId,
    paymentMode: order.payment_mode || "Cash",
    paid,
    dealer: {
      name: order.dealer_name,
      code: order.dealer_code,
      address: null,
      city: null,
      state: null,
      pin: null,
      phone: order.dealer_phone,
      gst: null,
    },
    route: { name: order.route_name, code: order.route_code },
    items,
    totals: { taxable, cgst, sgst, grand },
  });

  let pdfUrl: string | null = null;
  try {
    pdfUrl = await tryUploadR2(
      `invoices/${deliveryDate.getFullYear()}/${invoiceNumber}.pdf`,
      pdfBytes
    );
  } catch (err) {
    console.warn("[invoice] R2 upload failed:", err);
  }

  await pgClient`
    INSERT INTO invoices (
        order_id, employee_id, invoice_number,
        invoice_date, delivery_date,
        taxable_amount, cgst, sgst, total_tax, total_amount,
        dealer_name, dealer_gst_number, dealer_address,
        route_id, pdf_url, pdf_generated_at
    ) VALUES (
        ${employeeOrderId}, ${order.employee_id}, ${invoiceNumber},
        now(), ${order.order_date}::date,
        ${taxable.toFixed(2)}::numeric, ${cgst.toFixed(2)}::numeric,
        ${sgst.toFixed(2)}::numeric, ${totalGst.toFixed(2)}::numeric,
        ${netAmount.toFixed(2)}::numeric,
        ${order.dealer_name}, NULL, NULL,
        (SELECT route_id FROM employee_orders WHERE id = ${employeeOrderId}),
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

  return { pdfUrl, pdfBytes, invoiceNumber };
}

export type InvoiceReissueResult =
  | { status: "reissued"; invoiceNumber: string }
  | { status: "no_invoice" }
  | { status: "failed"; error: string };

/**
 * Reissue an order's tax invoice after its contents changed.
 *
 * Modifying a confirmed order rewrites orders.grand_total and its line items,
 * but the invoice minted at confirm time kept the ORIGINAL figures — so the
 * PDF already in the dealer's hands disagreed with the books (20+ orders in
 * 45 days as of 2026-07-30). Call this after any path that re-totals an order
 * which may already be invoiced.
 *
 * Reissue, not re-mint: generateInvoicePdfSync upserts on order_id, so the
 * invoice_number is unchanged (it derives from delivery year + order id) and
 * invoice_date — the legal date of issue — is deliberately left alone by the
 * ON CONFLICT clause. Only the lines, totals and PDF refresh.
 *
 * No-op when the order was never invoiced: a modification must never CREATE
 * an invoice for a draft or an unpaid pay-now order that isn't entitled to one.
 *
 * Never throws. The caller has already committed the stock and money movement;
 * a PDF render or R2 hiccup must not fail the request or, worse, suggest the
 * modification itself failed. The result says what happened so the caller can
 * surface "invoice not refreshed" to the admin.
 */
export async function reissueInvoiceIfExists(
  orderId: string
): Promise<InvoiceReissueResult> {
  try {
    const [inv] = await pgClient`
      SELECT invoice_number FROM invoices WHERE order_id = ${orderId} LIMIT 1
    `;
    if (!inv) return { status: "no_invoice" };
  } catch (err) {
    console.error("[invoice] reissue lookup failed:", err);
    return { status: "failed", error: String((err as Error)?.message ?? err) };
  }

  try {
    const { invoiceNumber } = await generateInvoicePdfSync(orderId);
    return { status: "reissued", invoiceNumber };
  } catch (err) {
    console.error(`[invoice] reissue failed for order ${orderId}:`, err);
    return { status: "failed", error: String((err as Error)?.message ?? err) };
  }
}

/** Optional R2 upload. If env vars aren't set, returns null. */
async function tryUploadR2(
  key: string,
  bytes: Uint8Array
): Promise<string | null> {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKey = process.env.R2_ACCESS_KEY_ID;
  const secret = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET_NAME;
  if (!accountId || !accessKey || !secret || !bucket) return null;

  const { S3Client, PutObjectCommand, GetObjectCommand } = await import(
    "@aws-sdk/client-s3"
  );
  const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");

  const s3 = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: accessKey, secretAccessKey: secret },
  });

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: bytes,
      ContentType: "application/pdf",
    })
  );

  const publicBase = process.env.R2_PUBLIC_URL;
  if (publicBase) return `${publicBase}/${key}`;
  return await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn: 7 * 24 * 60 * 60 }
  );
}