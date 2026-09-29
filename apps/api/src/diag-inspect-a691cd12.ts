// ═══════════════════════════════════════════════════════════════════════
// diag-inspect-a691cd12.ts — READ ONLY.
// Complaint: this gate pass is PAID, but (a) its invoice / bill # link looks
// wrong, and (b) the payment never shows up in the Day Book.
//
// USAGE (from apps/api):  npx tsx src/diag-inspect-a691cd12.ts
// ═══════════════════════════════════════════════════════════════════════

import { pgClient } from "./lib/db.js";

const ID = "a691cd12-1636-4323-94b6-329b5f9551f1";

async function main() {
  const [{ d: today }] = (await pgClient`
    SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS d
  `) as any[];
  console.log("today (IST):", today);
  console.log("target id  :", ID, "\n");

  const [s] = (await pgClient`
    SELECT ds.id::text AS id, ds.gp_no AS "gpNo",
           ds.customer_type::text AS "customerType",
           ds.customer_id::text AS "customerId",
           ds.status::text AS status,
           ds.payment_mode::text AS "paymentMode", ds.payment_ref AS "paymentRef",
           ds.subtotal::numeric AS subtotal, ds.total_gst::numeric AS gst,
           ds.grand_total::numeric AS total,
           ds.sale_date::text AS "saleDate", ds.route_id::text AS "routeId",
           ds.officer_id::text AS "officerId",
           ds.recipient_name AS "recipientName", ds.notes,
           ds.dispatched_at::text AS "dispatchedAt",
           ds.cancelled_at::text AS "cancelledAt",
           ds.created_at::text AS "createdAt", ds.updated_at::text AS "updatedAt",
           d.code AS "dealerCode", d.name AS "dealerName",
           r.name AS "routeName", u.name AS "officerName"
      FROM direct_sales ds
      LEFT JOIN dealers d ON d.id = ds.customer_id
      LEFT JOIN routes r  ON r.id = ds.route_id
      LEFT JOIN users u   ON u.id = ds.officer_id
     WHERE ds.id = ${ID}::uuid
  `) as any[];

  if (!s) {
    console.log("✗ not a direct sale");
    await pgClient.end();
    return;
  }

  console.log("── the sale ──");
  console.log(`  ${s.gpNo}   type=${s.customerType}  status=${s.status}`);
  console.log(`  customer : ${s.dealerCode ?? "-"} ${s.dealerName ?? "(walk-in / non-dealer)"}  customer_id=${s.customerId ?? "-"}`);
  console.log(`  route    : ${s.routeName ?? "-"}   officer: ${s.officerName ?? "-"}`);
  console.log(`  money    : subtotal ₹${s.subtotal} + gst ₹${s.gst} = ₹${s.total}`);
  console.log(`  payment  : mode=${s.paymentMode}   payment_ref=${s.paymentRef ?? "NULL"}`);
  console.log(`  sale_date=${s.saleDate}  dispatched_at=${s.dispatchedAt ?? "-"}  cancelled_at=${s.cancelledAt ?? "-"}`);
  console.log(`  created=${s.createdAt}  updated=${s.updatedAt}`);
  console.log(`  recipient=${s.recipientName ?? "-"}  notes=${s.notes ?? "-"}`);

  // ── 1. line items ──
  const items = (await pgClient`
    SELECT p.code, dsi.product_name AS name, dsi.quantity,
           dsi.unit_price::numeric AS price, dsi.gst_amount::numeric AS gst,
           dsi.line_total::numeric AS line
      FROM direct_sale_items dsi
      JOIN products p ON p.id = dsi.product_id
     WHERE dsi.direct_sale_id = ${ID}::uuid
     ORDER BY p.code
  `) as any[];
  console.log(`\n── direct_sale_items (${items.length}) ──`);
  for (const i of items)
    console.log(`  ${String(i.code).padEnd(8)} ${String(i.name).slice(0, 28).padEnd(30)} qty=${i.quantity} × ₹${i.price} (+gst ₹${i.gst}) = ₹${i.line}`);

  // ── 2. THE INVOICE LINK ──
  const invByOrder = (await pgClient`
    SELECT id::text AS id, invoice_number AS "invoiceNumber",
           invoice_date::text AS "invoiceDate", order_id::text AS "orderId",
           dealer_id::text AS "dealerId", employee_id::text AS "employeeId",
           taxable_amount::numeric AS taxable, total_tax::numeric AS tax,
           total_amount::numeric AS total,
           payment_status::text AS "paymentStatus",
           paid_amount::numeric AS paid, due_date::text AS "dueDate",
           delivery_date::text AS "deliveryDate", route_id::text AS "routeId",
           dealer_name AS "dealerName", dealer_gst_number AS "gstin",
           pdf_url AS "pdfUrl", created_at::text AS "createdAt"
      FROM invoices WHERE order_id = ${ID}::uuid
     ORDER BY created_at
  `) as any[];
  console.log(`\n── invoices WHERE order_id = this sale (${invByOrder.length}) ──`);
  if (!invByOrder.length) console.log("  none  ← the bill # link has nothing to resolve");
  for (const i of invByOrder) {
    console.log(`  ${i.invoiceNumber}  inv_date=${i.invoiceDate}  delivery_date=${i.deliveryDate ?? "-"}`);
    console.log(`      taxable ₹${i.taxable} + tax ₹${i.tax} = ₹${i.total}   (sale total ₹${s.total}) ${Number(i.total) === Number(s.total) ? "✓ match" : "✗ MISMATCH"}`);
    console.log(`      payment_status=${i.paymentStatus} paid=₹${i.paid} due=${i.dueDate ?? "-"}`);
    console.log(`      dealer_id=${i.dealerId ?? "-"} employee_id=${i.employeeId ?? "-"} name="${i.dealerName ?? "-"}" gstin=${i.gstin ?? "-"}`);
    console.log(`      id=${i.id}  route=${i.routeId ?? "-"}  pdf=${i.pdfUrl ?? "-"}  created=${i.createdAt}`);
  }

  // duplicate invoice numbers? (a wrong bill # link often = number reused)
  for (const i of invByOrder) {
    const dupes = (await pgClient`
      SELECT inv.id::text AS id, inv.order_id::text AS "orderId",
             inv.total_amount::numeric AS total, inv.created_at::text AS "createdAt",
             ds.gp_no AS "gpNo", o.id::text AS "orderNumber"
        FROM invoices inv
        LEFT JOIN direct_sales ds ON ds.id = inv.order_id
        LEFT JOIN orders o        ON o.id = inv.order_id
       WHERE inv.invoice_number = ${i.invoiceNumber}
       ORDER BY inv.created_at
    `) as any[];
    if (dupes.length > 1) {
      console.log(`\n  ⚠ invoice_number ${i.invoiceNumber} is on ${dupes.length} rows:`);
      for (const d of dupes)
        console.log(`      ${d.id} → ${d.gpNo ?? d.orderNumber ?? d.orderId}  ₹${d.total}  ${d.createdAt}`);
    }
  }

  // invoices minted around the same time — mis-link suspects
  const invNear = (await pgClient`
    SELECT i.invoice_number AS "invoiceNumber", i.order_id::text AS "orderId",
           i.total_amount::numeric AS total, i.created_at::text AS "createdAt",
           ds.gp_no AS "gpNo", o.id::text AS "orderNumber"
      FROM invoices i
      LEFT JOIN direct_sales ds ON ds.id = i.order_id
      LEFT JOIN orders o        ON o.id = i.order_id
     WHERE i.created_at BETWEEN ${s.createdAt}::timestamptz - interval '15 minutes'
                            AND ${s.createdAt}::timestamptz + interval '60 minutes'
     ORDER BY i.created_at
  `) as any[];
  console.log(`\n── invoices minted near this sale's creation (${invNear.length}) ──`);
  for (const i of invNear)
    console.log(`  ${String(i.invoiceNumber).padEnd(22)} ₹${String(i.total).padEnd(10)} ${i.createdAt}  → ${i.gpNo ?? i.orderNumber ?? i.orderId}`);

  // ── 3. THE MONEY: gateway rows ──
  const rps = (await pgClient`
    SELECT id::text AS id, kind::text AS kind, status::text AS status,
           amount::numeric AS amount, amount_refunded::numeric AS refunded,
           razorpay_qr_code_id AS "qrId", razorpay_payment_id AS "rzpId",
           razorpay_order_id AS "rzpOrderId",
           direct_sale_id::text AS "saleId", order_id::text AS "orderId",
           dealer_id::text AS "dealerId",
           webhook_received AS "webhookReceived", notes,
           created_at::text AS "createdAt", paid_at::text AS "paidAt",
           reconciled_at::text AS "reconciledAt"
      FROM razorpay_payments
     WHERE direct_sale_id = ${ID}::uuid
        OR order_id = ${ID}::uuid
        OR (${s.paymentRef}::text IS NOT NULL AND (razorpay_payment_id = ${s.paymentRef}::text OR razorpay_qr_code_id = ${s.paymentRef}::text))
     ORDER BY created_at
  `) as any[];
  console.log(`\n── razorpay_payments for this sale (${rps.length}) ──`);
  if (!rps.length) console.log("  none");
  for (const r of rps) {
    console.log(`  ${r.kind} status=${r.status} ₹${r.amount} refunded=₹${r.refunded}`);
    console.log(`      qr=${r.qrId ?? "-"} pay=${r.rzpId ?? "-"} rzp_order=${r.rzpOrderId ?? "-"}`);
    console.log(`      direct_sale_id=${r.saleId ?? "-"} order_id=${r.orderId ?? "-"} dealer_id=${r.dealerId ?? "-"}`);
    console.log(`      webhook=${r.webhookReceived} created=${r.createdAt} paid=${r.paidAt ?? "-"} reconciled=${r.reconciledAt ?? "-"}`);
    console.log(`      notes=${r.notes ? JSON.stringify(r.notes) : "-"}`);
  }

  // ── 4. receipts table ──
  const pays = (await pgClient`
    SELECT p.id::text AS id, p.dealer_id::text AS "dealerId", p.received_date::text AS "date",
           p.amount::numeric AS amount, p.mode::text AS mode, p.reference, p.notes,
           p.invoice_id::text AS "invoiceId", p.created_at::text AS "createdAt"
      FROM payments p
     WHERE p.reference ILIKE ${"%" + ID + "%"} OR p.notes ILIKE ${"%" + ID + "%"}
        OR p.reference ILIKE ${"%" + (s.gpNo ?? "@@none@@") + "%"}
        OR p.notes ILIKE ${"%" + (s.gpNo ?? "@@none@@") + "%"}
        OR (${s.paymentRef}::text IS NOT NULL AND p.reference = ${s.paymentRef}::text)
     ORDER BY p.created_at
  `) as any[];
  console.log(`\n── payments (receipts) naming this sale (${pays.length}) ──`);
  if (!pays.length) console.log("  none  ← nothing on the Day Book receipts side");
  for (const p of pays)
    console.log(`  ${p.date} ₹${p.amount} ${p.mode} ref=${p.reference ?? "-"} notes=${p.notes ?? "-"} dealer=${p.dealerId ?? "-"} inv=${p.invoiceId ?? "-"}`);

  // ── 5. ledger ──
  const leds = (await pgClient`
    SELECT dealer_id::text AS "dealerId", type::text AS type, amount::numeric AS amount,
           reference_type::text AS "refType", reference_id::text AS "refId",
           voucher_type AS "voucherType", description, created_at::text AS "createdAt"
      FROM dealer_ledger
     WHERE reference_id = ${ID}::uuid OR description ILIKE ${"%" + (s.gpNo ?? "@@none@@") + "%"}
     ORDER BY created_at
  `) as any[];
  console.log(`\n── dealer_ledger rows for this sale (${leds.length}) ──`);
  if (!leds.length) console.log("  none");
  for (const l of leds)
    console.log(`  ${l.type} ₹${l.amount} ref=${l.refType} voucher=${l.voucherType} :: ${l.description}`);

  // ── 6. all sales that day, for context ──
  const sibs = (await pgClient`
    SELECT ds.id::text AS id, ds.gp_no AS "gpNo", ds.grand_total::numeric AS total,
           ds.status::text AS status,
           ds.payment_mode::text AS "paymentMode", ds.payment_ref AS "paymentRef",
           ds.created_at::text AS "createdAt",
           i.invoice_number AS "invoiceNumber", i.total_amount::numeric AS "invTotal"
      FROM direct_sales ds
      LEFT JOIN invoices i ON i.order_id = ds.id
     WHERE ds.sale_date = ${s.saleDate}::date
     ORDER BY ds.created_at
  `) as any[];
  console.log(`\n── every direct sale on ${s.saleDate} (${sibs.length}) ──`);
  for (const x of sibs)
    console.log(`  ${x.id === ID ? "→" : " "} ${String(x.gpNo ?? "-").padEnd(9)} ₹${String(x.total).padEnd(10)} ${String(x.status).padEnd(10)} ${String(x.paymentMode).padEnd(8)} inv=${String(x.invoiceNumber ?? "NONE").padEnd(20)} invTot=${x.invTotal ?? "-"}  ref=${x.paymentRef ?? "-"}`);

  await pgClient.end();
}

main().catch(async (e) => {
  console.error(e);
  await pgClient.end();
  process.exit(1);
});
