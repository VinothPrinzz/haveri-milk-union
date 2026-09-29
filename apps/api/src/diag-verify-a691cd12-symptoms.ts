// ═══════════════════════════════════════════════════════════════════════
// diag-verify-a691cd12-symptoms.ts — READ ONLY.
// Reproduces, against prod, exactly what the two screens the user is
// looking at receive:
//   A. GET /api/v1/invoices/:id  for GP-0037's invoice  (Invoice Detail)
//   B. GET /api/v1/finance/day-book?date=2026-08-07     (Day Book)
// so the "invoice is wrong" and "payment not in day book" claims are
// confirmed from the actual query text those routes run, not by reading.
//
// USAGE (from apps/api):  npx tsx src/diag-verify-a691cd12-symptoms.ts
// ═══════════════════════════════════════════════════════════════════════

import { pgClient } from "./lib/db.js";

const SALE_ID = "a691cd12-1636-4323-94b6-329b5f9551f1";
const INVOICE_ID = "1b889dc6-328a-423c-968c-3f154a521293";
const DATE = "2026-08-07";

async function main() {
  // ── A. the invoice detail endpoint's own header query ──
  const [invoice] = (await pgClient`
    SELECT
      i.id::text AS id,
      i.invoice_number      AS "invoiceNumber",
      i.order_id::text      AS "orderId",
      i.taxable_amount::numeric AS "taxableAmount",
      i.cgst::numeric, i.sgst::numeric,
      i.total_tax::numeric  AS "totalTax",
      i.total_amount::numeric AS "totalAmount",
      i.payment_status      AS "paymentStatus",
      COALESCE(o.route_id, eo.route_id, d.route_id)::text AS "routeId",
      COALESCE(o.status, eo.status)             AS "orderStatus",
      COALESCE(o.payment_mode, eo.payment_mode) AS "paymentMode",
      COALESCE(o.item_count, eo.item_count)     AS "itemCount",
      COALESCE(o.delivery_date, eo.delivery_date)::text AS "deliveryDate",
      COALESCE(o.grand_total, eo.grand_total)::numeric  AS "orderGrandTotal",
      r.name AS "routeName"
    FROM invoices i
    LEFT JOIN dealers d   ON d.id = i.dealer_id
    LEFT JOIN employees e ON e.id = i.employee_id
    LEFT JOIN orders o    ON o.id = i.order_id
    LEFT JOIN employee_orders eo ON eo.id = i.order_id
    LEFT JOIN routes r ON r.id = COALESCE(o.route_id, eo.route_id, d.route_id)
    WHERE i.id = ${INVOICE_ID}
    LIMIT 1
  `) as any[];

  console.log("══ A. what GET /invoices/:id returns for GP-0037 ══\n");
  console.log("  invoice header:");
  console.log(`    invoiceNumber = ${invoice.invoiceNumber}`);
  console.log(`    taxableAmount = ${invoice.taxableAmount}`);
  console.log(`    cgst=${invoice.cgst} sgst=${invoice.sgst} totalTax=${invoice.totalTax}`);
  console.log(`    totalAmount   = ${invoice.totalAmount}   ← stored, pre-rounded`);
  console.log(`    orderStatus   = ${invoice.orderStatus ?? "NULL"}`);
  console.log(`    paymentMode   = ${invoice.paymentMode ?? "NULL"}`);
  console.log(`    itemCount     = ${invoice.itemCount ?? "NULL"}`);
  console.log(`    deliveryDate  = ${invoice.deliveryDate ?? "NULL"}`);
  console.log(`    orderGrandTotal = ${invoice.orderGrandTotal ?? "NULL"}`);
  console.log(`    paymentStatus = ${invoice.paymentStatus}`);
  console.log(`    routeName     = ${invoice.routeName ?? "NULL"}`);

  // the endpoint's items query, verbatim in shape
  const items = (await pgClient`
    SELECT oi.product_name AS "productName", oi.quantity,
           oi.unit_price::numeric AS "unitPrice",
           (oi.quantity * oi.unit_price)::numeric(10,2) AS "basic"
      FROM order_items oi WHERE oi.order_id = ${SALE_ID}
    UNION ALL
    SELECT eoi.product_name, eoi.quantity, eoi.unit_price,
           (eoi.quantity * eoi.unit_price)::numeric(10,2)
      FROM employee_order_items eoi WHERE eoi.employee_order_id = ${SALE_ID}
    ORDER BY "productName"
  `) as any[];
  console.log(`\n  line items returned: ${items.length}`);
  for (const i of items) console.log(`    ${i.productName} qty=${i.quantity}`);
  if (!items.length)
    console.log("    (none — the endpoint never looks in direct_sale_items)");

  // what the page then computes
  const taxable = items.reduce(
    (s: number, l: any) => s + (parseFloat(l.basic) || 0), 0
  );
  const cgst = parseFloat(invoice.cgst) || 0;
  const sgst = parseFloat(invoice.sgst) || 0;
  const grandTotal = taxable + cgst + sgst;
  const rawStatus = String(invoice.paymentStatus ?? "").toLowerCase();
  const orderStatus = String(invoice.orderStatus ?? "").toLowerCase();
  const paymentStatus =
    rawStatus === "paid" || rawStatus === "partial"
      ? rawStatus
      : ["confirmed", "dispatched", "delivered"].includes(orderStatus)
      ? "paid"
      : "unpaid";
  console.log("\n  → InvoiceDetailPage therefore renders:");
  console.log(`    Total Taxable Value : ${taxable.toFixed(2)}   (real: 606.06)`);
  console.log(`    GRAND TOTAL / NET   : ${grandTotal.toFixed(2)}   (real: 636.36)`);
  console.log(`    Payment Status      : ${paymentStatus === "paid" ? "PAID" : "NOT PAID"}   (money is in: ₹636.36)`);
  console.log(`    Payment Mode        : "${invoice.paymentMode ?? ""}"   (real: upi)`);
  console.log(`    Delivery Date       : ${invoice.deliveryDate ?? "(blank)"}`);
  console.log(`    Line item rows      : ${items.length}`);

  // ── B. Day Book for the day ──
  console.log(`\n\n══ B. Day Book for ${DATE} ══\n`);

  const receipts = (await pgClient`
    SELECT p.id::text AS id, p.amount::float8 AS amount, p.mode::text AS mode,
           p.reference, d.code AS "dealerCode"
      FROM payments p JOIN dealers d ON d.id = p.dealer_id
     WHERE p.received_date = ${DATE}::date
     ORDER BY p.created_at
  `) as any[];
  console.log(`  receipts section (payments table): ${receipts.length} rows`);
  for (const r of receipts)
    console.log(`    ₹${r.amount} ${r.mode} ${r.dealerCode} ref=${r.reference ?? "-"}`);
  const totalReceipts = receipts.reduce((s: number, r: any) => s + r.amount, 0);
  console.log(`    totalReceipts = ₹${totalReceipts.toFixed(2)}`);
  console.log(
    `    GP-0037's ₹636.36 present? ${
      receipts.some((r: any) => r.reference === "pay_TMkWy3P3UUfKgo") ? "YES" : "NO"
    }`
  );

  const counter = (await pgClient`
    SELECT ds.gp_no AS "gpNo", ds.grand_total::float8 AS amount,
           ds.payment_mode::text AS mode, ds.payment_ref AS reference
      FROM direct_sales ds
     WHERE ds.sale_date = ${DATE}::date AND ds.status = 'confirmed'
     ORDER BY ds.created_at
  `) as any[];
  console.log(`\n  counter-sales section: ${counter.length} rows (cashImpact hard-coded 'none')`);
  for (const c of counter)
    console.log(`    ${c.gpNo} ₹${c.amount} ${c.mode} ref=${c.reference ?? "-"}`);

  // gate-pass gateway money actually collected that day
  const gp = (await pgClient`
    SELECT rp.razorpay_payment_id AS "rzpId",
           (rp.amount - rp.amount_refunded)::float8 AS net,
           rp.status::text AS status, rp.paid_at::text AS "paidAt",
           ds.gp_no AS "gpNo"
      FROM razorpay_payments rp
      JOIN direct_sales ds ON ds.id = rp.direct_sale_id
     WHERE rp.kind = 'gate_pass'
       AND rp.status IN ('paid', 'refunded')
       AND (rp.paid_at AT TIME ZONE 'Asia/Kolkata')::date = ${DATE}::date
     ORDER BY rp.paid_at
  `) as any[];
  const gpTotal = gp.reduce((s: number, x: any) => s + x.net, 0);
  console.log(`\n  REAL gate-pass money that hit the bank on ${DATE}: ${gp.length} payment(s), ₹${gpTotal.toFixed(2)}`);
  for (const x of gp)
    console.log(`    ${x.gpNo} ₹${x.net} ${x.rzpId} paid_at=${x.paidAt}`);
  console.log(
    `\n  → Day Book cash position counts ₹${totalReceipts.toFixed(2)}; ₹${gpTotal.toFixed(
      2
    )} of real collections is invisible to it.`
  );

  // ── C. how widespread is this? ──
  console.log("\n\n══ C. blast radius ══\n");
  const [{ n: gpPaidEver }] = (await pgClient`
    SELECT count(*)::int AS n FROM razorpay_payments
     WHERE kind = 'gate_pass' AND status IN ('paid', 'refunded')
  `) as any[];
  const [{ n: gpWithReceipt }] = (await pgClient`
    SELECT count(*)::int AS n
      FROM razorpay_payments rp
     WHERE rp.kind = 'gate_pass' AND rp.status IN ('paid', 'refunded')
       AND EXISTS (SELECT 1 FROM payments p WHERE p.reference = rp.razorpay_payment_id)
  `) as any[];
  const [{ s: gpSum }] = (await pgClient`
    SELECT COALESCE(SUM(amount - amount_refunded), 0)::float8 AS s
      FROM razorpay_payments
     WHERE kind = 'gate_pass' AND status IN ('paid', 'refunded')
  `) as any[];
  console.log(`  gate-pass QR payments captured ever : ${gpPaidEver}  (₹${Number(gpSum).toFixed(2)})`);
  console.log(`  ...of which have a payments receipt : ${gpWithReceipt}`);

  const [{ n: dsInv }] = (await pgClient`
    SELECT count(*)::int AS n
      FROM invoices i JOIN direct_sales ds ON ds.id = i.order_id
  `) as any[];
  const [{ n: dsInvBadTotal }] = (await pgClient`
    SELECT count(*)::int AS n
      FROM invoices i JOIN direct_sales ds ON ds.id = i.order_id
     WHERE i.total_amount <> ds.grand_total
  `) as any[];
  console.log(`\n  invoices that belong to a DIRECT SALE : ${dsInv}`);
  console.log(`    → every one renders with 0 line items on /sales/invoices/:id`);
  console.log(`  ...whose stored total <> the sale total : ${dsInvBadTotal}`);

  const [{ n: allInv }] = (await pgClient`SELECT count(*)::int AS n FROM invoices`) as any[];
  const [{ n: roundedOff }] = (await pgClient`
    SELECT count(*)::int AS n FROM invoices
     WHERE total_amount <> (taxable_amount + total_tax)
  `) as any[];
  console.log(`\n  invoices in total : ${allInv}`);
  console.log(`  ...where total_amount <> taxable + tax (the Math.round) : ${roundedOff}`);

  await pgClient.end();
}

main().catch(async (e) => {
  console.error(e);
  await pgClient.end();
  process.exit(1);
});
