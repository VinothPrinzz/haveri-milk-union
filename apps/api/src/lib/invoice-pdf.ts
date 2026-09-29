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
import { resolveOrderSettlement, resolveTermDays } from "./invoice-settlement.js";

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
      -- The Razorpay pay_* id for a pay-per-order UPI sale, and the account
      -- type that decides whether a ledger debit is spent balance or a
      -- receivable. Both feed resolveOrderSettlement below.
      o.payment_reference,
      d.customer_type,
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
      z.name        AS dealer_taluka,
      d.state       AS dealer_state,
      d.pin_code    AS dealer_pin,
      r.code        AS route_code,
      r.name        AS route_name
    FROM orders o
    JOIN dealers d      ON d.id = o.dealer_id
    LEFT JOIN zones z   ON z.id = d.zone_id
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

  // ── Settlement ─────────────────────────────────────────────────────
  // What the dealer has actually paid against this order, from the money
  // rails themselves. Both the PAID stamp on the PDF and the persisted
  // paid_amount / payment_status come from this one verdict, so the
  // document and the books can no longer disagree — previously the stamp
  // said PAID for every placed order (including credit-institution
  // receivables) while the row stayed 'unpaid' forever.
  const settlement = await resolveOrderSettlement({
    orderId,
    paymentReference: order.payment_reference,
    customerType: order.customer_type,
    grandTotal: grand,
  });
  // A cancelled or draft order is never stamped PAID regardless of what the
  // rails show; the stamp speaks for the document as issued.
  const placed = ["confirmed", "dispatched", "delivered"].includes(order.status);
  const paid = placed && settlement.paymentStatus === "paid";

  // Credit terms for this party. Deliberately NOT refreshed on reissue below:
  // due_date derives from the legal issue date, which the ON CONFLICT clause
  // also leaves alone, so a reissue must not silently extend the term.
  const termDays = resolveTermDays(order.customer_type);

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
      // Every dealer is in Haveri district, so the district alone locates
      // nobody - the taluka goes ahead of it on the address line.
      city: [order.dealer_taluka, order.dealer_city].filter(Boolean).join(", ") || null,
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
        invoice_date, due_date, delivery_date,
        taxable_amount, cgst, sgst, total_tax, total_amount,
        payment_status, paid_amount,
        dealer_name, dealer_gst_number, dealer_address,
        pdf_url, pdf_generated_at
    ) VALUES (
        ${orderId}, ${order.dealer_id}, ${invoiceNumber},
        -- Terms run from the legal issue date, in IST. Computed here rather
        -- than in JS so it can never drift a day across the timezone.
        now(), ((now() AT TIME ZONE 'Asia/Kolkata')::date + ${termDays}::int),
        ${order.order_date}::date,
        ${taxable.toFixed(2)}::numeric, ${cgst.toFixed(2)}::numeric,
        ${sgst.toFixed(2)}::numeric, ${totalGst.toFixed(2)}::numeric,
        -- The exact figure, NOT Math.round(grand). Rounding here left the
        -- stored header not adding up (606.06 + 30.30 = 636.00) on 4,367 of
        -- 4,576 rows, so anything reading total_amount was off by the paise.
        -- The PDF has always printed the unrounded grand total.
        ${grand.toFixed(2)}::numeric,
        ${settlement.paymentStatus}, ${settlement.paidAmount.toFixed(2)}::numeric,
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
            -- Recomputed from the money rails, not incremented, so a reissue
            -- after a modify or a cancel-and-refund re-reads the truth
            -- without dropping a receipt recorded against the invoice.
            payment_status   = EXCLUDED.payment_status,
            paid_amount      = EXCLUDED.paid_amount,
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
        -- Exact, not rounded — see the note in generateInvoicePdfSync.
        ${grand.toFixed(2)}::numeric,
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

/**
 * Direct-sale tax invoice (agent gate pass, cash counter sale, VIP sample).
 *
 * Third rail, same document. A direct sale lives in direct_sales /
 * direct_sale_items and its party depends on customer_type: an 'agent' sale
 * bills a real dealer (customer_id references dealers), a 'cash' sale bills a
 * cash_customers row or a walk-in, a 'vip_sample' names a vip_contacts row.
 * So:
 *
 *   • agent → invoices.dealer_id = the dealer, exactly like an indent.
 *   • cash / vip → dealer_id stays NULL and dealer_name carries the party.
 *     Migration 0071 relaxed invoices_party_chk to num_nonnulls(...) <= 1 for
 *     precisely this case; before that, a party-less invoice was rejected.
 *
 * EVERY direct sale gets a document, including a VIP sample and any other
 * zero-value issue. Those used to be refused on the grounds that a giveaway is
 * not a taxable supply — but the counter still has to hand the recipient a
 * priced record of what left the gate, and Recent Sales has to be able to open
 * it. A zero-value issue therefore prints the same layout footing at Rs. 0.00,
 * carrying the complimentary payment mode, and is never a receivable.
 */
export async function generateDirectSaleInvoicePdfSync(
  saleId: string
): Promise<InvoicePdfResult> {
  const [sale] = await pgClient`
    SELECT
      ds.id, ds.subtotal, ds.total_gst, ds.grand_total, ds.payment_mode,
      ds.status::text        AS status,
      ds.customer_type::text AS customer_type,
      ds.gp_no,
      ds.sale_date           AS order_date,
      ds.route_id,
      -- Party: a dealer for an agent pass, a cash customer for a counter
      -- sale, the VIP contact for a sample, and the free-text recipient as
      -- the last resort (walk-in).
      CASE WHEN ds.customer_type = 'agent' THEN d.id END        AS dealer_id,
      COALESCE(d.code, '')                                      AS dealer_code,
      COALESCE(d.name, cc.name, vc.name, ds.recipient_name, 'Counter sale')
                                                                AS dealer_name,
      COALESCE(d.phone, cc.phone, vc.phone)                     AS dealer_phone,
      d.gst_number                                              AS dealer_gst,
      COALESCE(d.address, cc.address)                           AS dealer_address,
      d.city                                                    AS dealer_city,
      z.name                                                    AS dealer_taluka,
      d.state                                                   AS dealer_state,
      d.pin_code                                                AS dealer_pin,
      r.code                                                    AS route_code,
      r.name                                                    AS route_name
    FROM direct_sales ds
    LEFT JOIN dealers d
           ON ds.customer_type = 'agent' AND d.id = ds.customer_id
    LEFT JOIN zones z ON z.id = d.zone_id
    LEFT JOIN cash_customers cc
           ON ds.customer_type = 'cash'  AND cc.id = ds.customer_id
    LEFT JOIN vip_contacts vc
           ON ds.customer_type = 'vip_sample' AND vc.id = ds.customer_id
    LEFT JOIN routes r ON r.id = ds.route_id
    WHERE ds.id = ${saleId}
    LIMIT 1
  `;
  if (!sale) throw new Error(`Direct sale ${saleId} not found`);

  const grand = parseFloat(sale.grand_total ?? "0");

  const rawItems = await pgClient`
    SELECT
      dsi.product_name                           AS product_name,
      COALESCE(p.hsn_no, '')                     AS hsn_no,
      COALESCE(p.pack_size::text, '')            AS pack_size,
      dsi.quantity                               AS quantity,
      dsi.unit_price                             AS unit_price,
      (dsi.gst_amount / 2)::numeric(10,2)        AS cgst_amount,
      (dsi.gst_amount / 2)::numeric(10,2)        AS sgst_amount,
      dsi.line_total                             AS line_total,
      (dsi.quantity * dsi.unit_price)::numeric(10,2) AS basic
    FROM direct_sale_items dsi
    LEFT JOIN products p ON p.id = dsi.product_id
    WHERE dsi.direct_sale_id = ${saleId}
    ORDER BY dsi.product_name
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

  const deliveryDate = new Date(sale.order_date);
  const issueDate = new Date();
  const invoiceNumber =
    `INV-HMU-${deliveryDate.getFullYear()}-` + saleId.slice(0, 8).toUpperCase();

  const taxable = items.reduce((s, l) => s + l.basic, 0);
  const totalGst = parseFloat(sale.total_gst ?? "0");
  const cgst = totalGst / 2;
  const sgst = totalGst / 2;

  // "PAID" on a counter document means the money is in: cash was handed over
  // at the counter, a QR was scanned and captured, or the agent's prepaid
  // balance covered it (wallet — the union was already holding those funds,
  // and the sale draws them down through a dealer_ledger debit). A gate pass
  // taken on CREDIT is billed but unpaid, so it must not carry the paid mark:
  // it is a receivable and has to age in AR Aging. This is the same
  // wallet-vs-credit-institution split invoice-settlement.ts makes on the
  // orders rail.
  const [collectedRow] = await pgClient`
    SELECT COALESCE(SUM(rp.amount - rp.amount_refunded), 0)::float8 AS collected
      FROM razorpay_payments rp
     WHERE rp.direct_sale_id = ${saleId}
       AND rp.kind = 'gate_pass'
       AND rp.status IN ('paid', 'refunded')
  `;
  const collected = Number((collectedRow as any)?.collected ?? 0);
  // A zero-value issue (VIP sample, complimentary pass) has nothing to
  // collect, so it is settled the moment it is raised — it must never sit in
  // AR Aging as a receivable that can never be cleared.
  const paid =
    grand <= 0.001 ||
    sale.payment_mode === "cash" ||
    sale.payment_mode === "wallet" ||
    collected >= grand - 0.001;

  // The same verdict, persisted. The invoice row used to keep the 'unpaid'
  // default forever while the PDF beside it printed PAID, and the detail page
  // has no order status to fall back on for a counter sale — so a settled gate
  // pass read NOT PAID on screen. Cash is collected in full at the counter;
  // otherwise only what the QR actually captured counts.
  const paidAmount = paid ? grand : collected;
  const paymentStatus = paid ? "paid" : collected > 0.001 ? "partial" : "unpaid";

  const pdfBytes = await renderInvoicePdf({
    invoiceNumber,
    issueDate,
    deliveryDate,
    orderId: saleId,
    paymentMode: sale.payment_mode || "Cash",
    paid,
    dealer: {
      name: sale.dealer_name,
      code: sale.dealer_code || sale.gp_no || "",
      address: sale.dealer_address,
      // Taluka ahead of the district (see the order invoice above).
      city: [sale.dealer_taluka, sale.dealer_city].filter(Boolean).join(", ") || null,
      state: sale.dealer_state,
      pin: sale.dealer_pin,
      phone: sale.dealer_phone,
      gst: sale.dealer_gst,
    },
    route: { name: sale.route_name, code: sale.route_code },
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

  const addressSnapshot =
    [sale.dealer_address, sale.dealer_city, sale.dealer_pin]
      .filter(Boolean)
      .join(", ") || null;

  await pgClient`
    INSERT INTO invoices (
        order_id, dealer_id, invoice_number,
        invoice_date, due_date, delivery_date,
        taxable_amount, cgst, sgst, total_tax, total_amount,
        payment_status, paid_amount,
        dealer_name, dealer_gst_number, dealer_address,
        route_id, pdf_url, pdf_generated_at
    ) VALUES (
        ${saleId}, ${sale.dealer_id ?? null}, ${invoiceNumber},
        -- A counter sale is cash and carry: due the day it is issued. When it
        -- names a dealer and the QR never captured, it ages from day one
        -- rather than sitting outside AR entirely.
        now(), (now() AT TIME ZONE 'Asia/Kolkata')::date,
        ${sale.order_date}::date,
        ${taxable.toFixed(2)}::numeric, ${cgst.toFixed(2)}::numeric,
        ${sgst.toFixed(2)}::numeric, ${totalGst.toFixed(2)}::numeric,
        -- Exact, not rounded — see the note in generateInvoicePdfSync.
        ${grand.toFixed(2)}::numeric,
        ${paymentStatus}, ${paidAmount.toFixed(2)}::numeric,
        ${sale.dealer_name}, ${sale.dealer_gst || null}, ${addressSnapshot},
        ${sale.route_id ?? null}, ${pdfUrl}, now()
    )
    ON CONFLICT (order_id) DO UPDATE
        SET pdf_url          = EXCLUDED.pdf_url,
            delivery_date    = EXCLUDED.delivery_date,
            taxable_amount   = EXCLUDED.taxable_amount,
            cgst             = EXCLUDED.cgst,
            sgst             = EXCLUDED.sgst,
            total_tax        = EXCLUDED.total_tax,
            total_amount     = EXCLUDED.total_amount,
            -- A reissue re-reads what the QR has captured, so a pass that was
            -- scanned after the first mint stops reading NOT PAID.
            payment_status   = EXCLUDED.payment_status,
            paid_amount      = EXCLUDED.paid_amount,
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

/**
 * Reissue a DIRECT SALE's invoice after its quantities changed. Same contract
 * as reissueInvoiceIfExists: upserts on order_id so the number and legal issue
 * date are preserved, no-ops when the sale was never invoiced, and never
 * throws — the money and stock are already committed by the time it runs.
 */
export async function reissueDirectSaleInvoiceIfExists(
  saleId: string
): Promise<InvoiceReissueResult> {
  try {
    const [inv] = await pgClient`
      SELECT invoice_number FROM invoices WHERE order_id = ${saleId} LIMIT 1
    `;
    if (!inv) return { status: "no_invoice" };
  } catch (err) {
    console.error("[invoice] direct-sale reissue lookup failed:", err);
    return { status: "failed", error: String((err as Error)?.message ?? err) };
  }

  try {
    const { invoiceNumber } = await generateDirectSaleInvoicePdfSync(saleId);
    return { status: "reissued", invoiceNumber };
  } catch (err) {
    console.error(`[invoice] reissue failed for direct sale ${saleId}:`, err);
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