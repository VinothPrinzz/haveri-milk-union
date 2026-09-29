// ═══════════════════════════════════════════════════════════════════════
// diag-inspect-f5967d58.ts — READ ONLY. f5967d58-… is a DIRECT SALE
// (agent gate pass GP-0028). What is on it, and was any money collected?
//
// USAGE (from apps/api):  npx tsx src/diag-inspect-f5967d58.ts
// ═══════════════════════════════════════════════════════════════════════

import { pgClient } from "./lib/db.js";

const ID = "f5967d58-48c6-4a27-afdf-dd59c6b99b7d";

async function main() {
  const [{ d: today }] = (await pgClient`
    SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS d
  `) as any[];
  console.log("today (IST):", today);
  console.log("direct_sale:", ID, "\n");

  // ── 1. the sale ──
  const [s] = (await pgClient`
    SELECT ds.id::text AS id, ds.gp_no AS "gpNo",
           ds.customer_type::text AS "customerType",
           ds.customer_id::text AS "customerId",
           ds.payment_mode::text AS "paymentMode", ds.payment_ref AS "paymentRef",
           ds.subtotal::numeric AS subtotal, ds.total_gst::numeric AS gst,
           ds.grand_total::numeric AS total,
           ds.sale_date::text AS "saleDate", ds.route_id::text AS "routeId",
           ds.officer_id::text AS "officerId", ds.batch_id::text AS "batchId",
           ds.recipient_name AS "recipientName", ds.notes,
           ds.dispatched_at::text AS "dispatchedAt",
           ds.created_at::text AS "createdAt", ds.updated_at::text AS "updatedAt",
           d.code AS "dealerCode", d.name AS "dealerName",
           r.name AS "routeName",
           u.name AS "officerName"
      FROM direct_sales ds
      LEFT JOIN dealers d ON ds.customer_type = 'agent' AND d.id = ds.customer_id
      LEFT JOIN routes r ON r.id = ds.route_id
      LEFT JOIN users u ON u.id = ds.officer_id
     WHERE ds.id = ${ID}::uuid
  `) as any[];

  if (!s) {
    console.log("✗ direct sale not found");
    await pgClient.end();
    return;
  }

  console.log("── the sale ──");
  console.log(`  ${s.gpNo}   type=${s.customerType}`);
  console.log(`  customer : ${s.dealerCode ?? "-"} ${s.dealerName ?? "(not an agent/dealer)"}`);
  console.log(`  route    : ${s.routeName ?? "-"}   officer: ${s.officerName ?? "-"}`);
  console.log(`  money    : subtotal ₹${s.subtotal} + gst ₹${s.gst} = ₹${s.total}`);
  console.log(`  payment  : mode=${s.paymentMode}   payment_ref=${s.paymentRef ?? "NULL  ← nothing stamped by the QR webhook"}`);
  console.log(`  sale_date=${s.saleDate}  dispatched_at=${s.dispatchedAt ?? "-"}`);
  console.log(`  created=${s.createdAt}  updated=${s.updatedAt}`);
  console.log(`  batch=${s.batchId ?? "-"}  recipient=${s.recipientName ?? "-"}  notes=${s.notes ?? "-"}`);

  // ── 2. line items ──
  const items = (await pgClient`
    SELECT p.code, dsi.product_name AS name, dsi.quantity,
           dsi.unit_price::numeric AS price, dsi.gst_amount::numeric AS gst,
           dsi.line_total::numeric AS line, dsi.product_id::text AS "productId",
           COALESCE(p.stock_source_product_id, p.id)::text AS "stockProductId"
      FROM direct_sale_items dsi
      JOIN products p ON p.id = dsi.product_id
     WHERE dsi.direct_sale_id = ${ID}::uuid
     ORDER BY p.code
  `) as any[];
  console.log(`\n── direct_sale_items (${items.length}) ──`);
  for (const i of items)
    console.log(`  ${String(i.code).padEnd(8)} ${String(i.name).slice(0, 30).padEnd(32)} qty=${i.quantity} × ₹${i.price} (+gst ₹${i.gst}) = ₹${i.line}`);

  // ── 3. gate pass items (issued vs returned) ──
  const gpi = (await pgClient`
    SELECT p.code, gpi.quantity, gpi.returned_quantity AS returned
      FROM gate_pass_items gpi JOIN products p ON p.id = gpi.product_id
     WHERE gpi.direct_sale_id = ${ID}::uuid
     ORDER BY p.code
  `) as any[];
  console.log(`\n── gate_pass_items (${gpi.length}) ──`);
  for (const g of gpi) console.log(`  ${String(g.code).padEnd(8)} issued=${g.quantity} returned=${g.returned}`);

  // ── 4. gateway payments for this sale ──
  const rps = (await pgClient`
    SELECT id::text AS id, kind::text AS kind, status::text AS status,
           amount::numeric AS amount, amount_refunded::numeric AS refunded,
           razorpay_qr_code_id AS "qrId", razorpay_payment_id AS "rzpId",
           webhook_received AS "webhookReceived",
           created_at::text AS "createdAt", paid_at::text AS "paidAt",
           reconciled_at::text AS "reconciledAt"
      FROM razorpay_payments WHERE direct_sale_id = ${ID}::uuid
     ORDER BY created_at
  `) as any[];
  console.log(`\n── razorpay_payments for this sale (${rps.length}) ──`);
  if (!rps.length) console.log("  none — no counter QR was ever minted for this sale");
  for (const r of rps)
    console.log(`  ${r.kind} status=${r.status} ₹${r.amount} refunded=₹${r.refunded}\n      qr=${r.qrId ?? "-"} pay=${r.rzpId ?? "-"} webhook=${r.webhookReceived} created=${r.createdAt} paid=${r.paidAt ?? "-"}`);

  // ── 5. any receipt row naming this sale or its ref ──
  const pays = (await pgClient`
    SELECT id::text AS id, dealer_id::text AS "dealerId", received_date::text AS "date",
           amount::numeric AS amount, mode::text AS mode, reference, notes
      FROM payments
     WHERE reference ILIKE ${"%" + ID + "%"} OR notes ILIKE ${"%" + ID + "%"}
        OR (${s.paymentRef}::text IS NOT NULL AND reference = ${s.paymentRef}::text)
  `) as any[];
  console.log(`\n── payments (Day Book receipts) naming this sale (${pays.length}) ──`);
  for (const p of pays) console.log(`  ${p.date} ₹${p.amount} ${p.mode} ref=${p.reference ?? "-"}`);
  if (!pays.length) console.log("  none");

  // ── 6. ledger rows referencing this sale ──
  const leds = (await pgClient`
    SELECT dealer_id::text AS "dealerId", type::text AS type, amount::numeric AS amount,
           reference_type::text AS "refType", voucher_type AS "voucherType",
           description, created_at::text AS "createdAt"
      FROM dealer_ledger
     WHERE reference_id = ${ID}::uuid OR description ILIKE ${"%" + ID + "%"}
     ORDER BY created_at
  `) as any[];
  console.log(`\n── dealer_ledger rows referencing this sale (${leds.length}) ──`);
  if (!leds.length) console.log("  none");
  for (const l of leds)
    console.log(`  ${l.type} ₹${l.amount} ref=${l.refType} voucher=${l.voucherType} :: ${l.description}`);

  // ── 7. invoice for this sale, if the schema links one ──
  const invs = (await pgClient`
    SELECT invoice_number AS "invoiceNumber", invoice_date::text AS "invoiceDate",
           total_amount::numeric AS total, payment_status::text AS "paymentStatus"
      FROM invoices WHERE order_id = ${ID}::uuid
  `) as any[];
  console.log(`\n── invoices whose order_id = this sale (${invs.length}) ──`);
  if (!invs.length) console.log("  none");
  for (const i of invs) console.log(`  ${i.invoiceNumber} ${i.invoiceDate} ₹${i.total} ${i.paymentStatus}`);

  // ── 8. does this sale move FGS stock today? ──
  console.log(`\n── FGS position for the sale's products on ${s.saleDate} ──`);
  for (const i of items) {
    const [f] = (await pgClient`
      SELECT opening, received, dispatched, wastage, closing
        FROM fgs_day(${s.saleDate}::date) WHERE product_id = ${i.stockProductId}::uuid
    `) as any[];
    const [a] = (await pgClient`
      SELECT fgs_available(${i.stockProductId}::uuid, ${s.saleDate}::date) AS a
    `) as any[];
    const [p] = (await pgClient`
      SELECT stock::numeric AS stock FROM products WHERE id = ${i.productId}::uuid
    `) as any[];
    console.log(`  ${String(i.code).padEnd(8)} fgs: opening=${f?.opening} received=${f?.received} dispatched=${f?.dispatched} closing=${f?.closing}  available=${a?.a}  products.stock=${p?.stock}`);
  }

  // ── 9. other sales for this agent today (context) ──
  const sibs = (await pgClient`
    SELECT id::text AS id, gp_no AS "gpNo", grand_total::numeric AS total,
           payment_mode::text AS "paymentMode", payment_ref AS "paymentRef",
           created_at::text AS "createdAt"
      FROM direct_sales
     WHERE customer_id = ${s.customerId}::uuid AND sale_date = ${s.saleDate}::date
     ORDER BY created_at
  `) as any[];
  console.log(`\n── this agent's other sales on ${s.saleDate} (${sibs.length}) ──`);
  for (const x of sibs)
    console.log(`  ${x.id === ID ? "→" : " "} ${x.gpNo ?? "-"} ₹${x.total} ${x.paymentMode} ref=${x.paymentRef ?? "-"} @ ${x.createdAt}`);

  await pgClient.end();
}

main().catch(async (e) => {
  console.error(e);
  await pgClient.end();
  process.exit(1);
});
