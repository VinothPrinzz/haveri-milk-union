// ═══════════════════════════════════════════════════════════════════════
// diag-verify-invoice-daybook-fix.ts — READ ONLY.
// Runs the POST-FIX query shapes from finance.ts and finance-day-book.ts
// against prod and prints what the two screens now render for GP-0037.
//
// USAGE (from apps/api):  npx tsx src/diag-verify-invoice-daybook-fix.ts
// ═══════════════════════════════════════════════════════════════════════

import { pgClient } from "./lib/db.js";

const SALE_ID = "a691cd12-1636-4323-94b6-329b5f9551f1";
const INVOICE_ID = "1b889dc6-328a-423c-968c-3f154a521293";
const DATE = "2026-08-07";

async function main() {
  // ── A. invoice detail, with the direct_sales rail joined in ──
  const [invoice] = (await pgClient`
    SELECT
      i.invoice_number      AS "invoiceNumber",
      i.order_id::text      AS "orderId",
      i.cgst::numeric, i.sgst::numeric,
      i.total_amount::numeric AS "totalAmount",
      i.payment_status      AS "paymentStatus",
      COALESCE(o.status, eo.status)            AS "orderStatus",
      COALESCE(o.payment_mode::text, eo.payment_mode::text, ds.payment_mode::text) AS "paymentMode",
      COALESCE(
        o.item_count, eo.item_count,
        (SELECT count(*)::int FROM direct_sale_items dsi
          WHERE dsi.direct_sale_id = ds.id)
      )                                        AS "itemCount",
      COALESCE(o.delivery_date, eo.delivery_date, ds.sale_date)::text AS "deliveryDate",
      COALESCE(o.grand_total, eo.grand_total, ds.grand_total)::numeric AS "orderGrandTotal",
      r.name AS "routeName"
    FROM invoices i
    LEFT JOIN dealers d   ON d.id = i.dealer_id
    LEFT JOIN employees e ON e.id = i.employee_id
    LEFT JOIN orders o    ON o.id = i.order_id
    LEFT JOIN employee_orders eo ON eo.id = i.order_id
    LEFT JOIN direct_sales ds ON ds.id = i.order_id
    LEFT JOIN routes r ON r.id = COALESCE(o.route_id, eo.route_id, ds.route_id, d.route_id)
    WHERE i.id = ${INVOICE_ID}
    LIMIT 1
  `) as any[];

  const items = (await pgClient`
    SELECT oi.product_name AS "productName", oi.quantity,
           oi.unit_price::numeric AS "unitPrice",
           (oi.gst_amount / 2)::numeric(10,2) AS "cgstAmount",
           (oi.gst_amount / 2)::numeric(10,2) AS "sgstAmount",
           oi.line_total::numeric AS "lineTotal",
           (oi.quantity * oi.unit_price)::numeric(10,2) AS "basic"
      FROM order_items oi WHERE oi.order_id = ${SALE_ID}
    UNION ALL
    SELECT eoi.product_name, eoi.quantity, eoi.unit_price,
           (eoi.gst_amount / 2)::numeric(10,2), (eoi.gst_amount / 2)::numeric(10,2),
           eoi.line_total, (eoi.quantity * eoi.unit_price)::numeric(10,2)
      FROM employee_order_items eoi WHERE eoi.employee_order_id = ${SALE_ID}
    UNION ALL
    SELECT dsi.product_name, dsi.quantity, dsi.unit_price,
           (dsi.gst_amount / 2)::numeric(10,2), (dsi.gst_amount / 2)::numeric(10,2),
           dsi.line_total, (dsi.quantity * dsi.unit_price)::numeric(10,2)
      FROM direct_sale_items dsi WHERE dsi.direct_sale_id = ${SALE_ID}
    ORDER BY "productName"
  `) as any[];

  const taxable = items.reduce((s: number, l: any) => s + (parseFloat(l.basic) || 0), 0);
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

  console.log("══ A. Invoice Detail page, after the fix ══\n");
  console.log(`  Invoice No     : ${invoice.invoiceNumber}`);
  console.log(`  Route Name     : ${invoice.routeName ?? "(blank)"}`);
  console.log(`  Delivery Date  : ${invoice.deliveryDate ?? "(blank)"}`);
  console.log(`  Payment Mode   : ${invoice.paymentMode ?? "(blank)"}`);
  console.log(`  line items     : ${items.length}`);
  for (const l of items)
    console.log(`      ${l.productName}  qty=${l.quantity} × ₹${l.unitPrice} = ₹${l.lineTotal}`);
  console.log(`  Total Taxable  : ${taxable.toFixed(2)}   (want 606.06)`);
  console.log(`  GRAND / NET    : ${grandTotal.toFixed(2)}   (want 636.36)`);
  console.log(`  stored total   : ${invoice.totalAmount}   (want 636.36 once backfilled)`);
  console.log(`  Payment Status : ${paymentStatus === "paid" ? "PAID" : paymentStatus.toUpperCase()}   (want PAID once backfilled)`);

  // ── B. Day Book, with section 1c ──
  console.log(`\n\n══ B. Day Book ${DATE}, after the fix ══\n`);

  const [{ n: payN, s: payS }] = (await pgClient`
    SELECT count(*)::int AS n, COALESCE(SUM(p.amount), 0)::float8 AS s
      FROM payments p JOIN dealers d ON d.id = p.dealer_id
     WHERE p.received_date = ${DATE}::date
  `) as any[];

  const counterCollections = (await pgClient`
    SELECT
      rp.id::text AS id, rp.paid_at::text AS at,
      'counter_collection' AS type, 'upi' AS mode,
      rp.amount::float8 AS amount,
      rp.razorpay_payment_id AS reference, ds.gp_no AS "docNo",
      d.code AS "dealerCode",
      COALESCE(d.name, cc.name,
               initcap(replace(ds.customer_type::text, '_', ' '))) AS "dealerName",
      r.name AS "routeName", u.name AS "byName"
    FROM razorpay_payments rp
    JOIN direct_sales ds ON ds.id = rp.direct_sale_id
    LEFT JOIN dealers d ON ds.customer_type = 'agent' AND d.id = ds.customer_id
    LEFT JOIN cash_customers cc ON ds.customer_type <> 'agent' AND cc.id = ds.customer_id
    LEFT JOIN routes r ON r.id = ds.route_id
    LEFT JOIN users u ON u.id = ds.officer_id
    WHERE rp.kind = 'gate_pass'
      AND rp.status IN ('paid', 'refunded')
      AND rp.paid_at IS NOT NULL
      AND (rp.paid_at AT TIME ZONE 'Asia/Kolkata')::date = ${DATE}::date
    ORDER BY rp.paid_at ASC
  `) as any[];

  const ccTotal = counterCollections.reduce((s: number, l: any) => s + l.amount, 0);
  console.log(`  payments receipts      : ${payN} rows, ₹${Number(payS).toFixed(2)}`);
  console.log(`  counter QR collections : ${counterCollections.length} rows, ₹${ccTotal.toFixed(2)}`);
  for (const l of counterCollections)
    console.log(`      ${l.docNo} ₹${l.amount} ${l.mode} ${l.dealerCode} ${l.dealerName}  route=${l.routeName ?? "-"}  by=${l.byName ?? "-"}  ref=${l.reference}`);
  console.log(`\n  totalReceipts          : ₹${(Number(payS) + ccTotal).toFixed(2)}   (was ₹${Number(payS).toFixed(2)})`);
  console.log(`  byType.counter_collection: ₹${ccTotal.toFixed(2)}`);

  // the counter sale is still booked once as revenue, cashImpact none
  const [{ n: csN, s: csS }] = (await pgClient`
    SELECT count(*)::int AS n, COALESCE(SUM(ds.grand_total), 0)::float8 AS s
      FROM direct_sales ds
     WHERE ds.sale_date = ${DATE}::date AND ds.status = 'confirmed'
  `) as any[];
  console.log(`\n  counter SALES (revenue, cashImpact none): ${csN} rows, ₹${Number(csS).toFixed(2)}`);
  console.log(`  → the ₹636.36 is counted once as a sale and once as a receipt, which is`);
  console.log(`    the same shape a dealer order has (order_sale + its pay-now receipt).`);

  // refunds must not double-subtract: nothing refunded yet
  const [{ n: rfN }] = (await pgClient`
    SELECT count(*)::int AS n FROM razorpay_refunds rf
      JOIN razorpay_payments rp ON rp.id = rf.razorpay_payment_row
     WHERE rp.kind = 'gate_pass'
  `) as any[];
  console.log(`\n  gate-pass refunds on record (section 3 handles these): ${rfN}`);

  await pgClient.end();
}

main().catch(async (e) => {
  console.error(e);
  await pgClient.end();
  process.exit(1);
});
