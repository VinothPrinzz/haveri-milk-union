// READ ONLY. Where is something being treated as a completed sale without the
// money having arrived? Checks BOTH rails for today and yesterday.
import { pgClient } from "./lib/db.js";

const [{ d: today }] = (await pgClient`
  SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS d
`) as any[];
console.log("today (IST):", today, "\n");

// ── Rail 1: direct sales (counter / gate pass) ──
const sales = (await pgClient`
  SELECT ds.gp_no AS "gpNo", ds.id::text AS id,
         ds.customer_type::text AS type,
         ds.payment_mode::text AS mode,
         ds.payment_ref AS ref,
         ds.grand_total::float8 AS total,
         ds.status,
         ds.sale_date::text AS "saleDate",
         ds.created_at::text AS "createdAt",
         COALESCE((
           SELECT SUM(rp.amount - rp.amount_refunded)::float8
             FROM razorpay_payments rp
            WHERE rp.direct_sale_id = ds.id AND rp.kind='gate_pass'
              AND rp.status IN ('paid','refunded')), 0) AS collected,
         (SELECT count(*)::int FROM razorpay_payments rp
           WHERE rp.direct_sale_id = ds.id) AS "qrRows",
         (SELECT string_agg(rp.status::text, ',' ORDER BY rp.created_at)
            FROM razorpay_payments rp WHERE rp.direct_sale_id = ds.id) AS "qrStates"
    FROM direct_sales ds
   WHERE ds.sale_date >= ${today}::date - 1
   ORDER BY ds.created_at DESC
`) as any[];

console.log(`── direct sales, last 2 days (${sales.length}) ──`);
for (const s of sales) {
  const owed = s.total - s.collected;
  const flag = s.total > 0 && owed > 0.001 && s.status === "confirmed" ? "  ⚠ BOOKED BUT UNPAID" : "";
  console.log(
    `  ${(s.gpNo ?? "-").padEnd(9)} ${s.type.padEnd(17)} ₹${String(s.total).padEnd(9)} mode=${s.mode.padEnd(14)} ` +
    `ref=${(s.ref ?? "-").padEnd(20)} collected=₹${s.collected} status=${s.status}${flag}`
  );
  console.log(`      id=${s.id}  created=${s.createdAt}  qrRows=${s.qrRows} [${s.qrStates ?? "-"}]`);
}

// ── Rail 2: dealer indents confirmed today ──
const orders = (await pgClient`
  SELECT o.id::text AS id, o.status::text AS status,
         o.payment_mode::text AS mode,
         o.grand_total::float8 AS total,
         o.delivery_date::text AS "deliveryDate",
         o.confirmed_at::text AS "confirmedAt",
         o.stock_deducted AS "stockDeducted",
         d.code AS "dealerCode", d.name AS "dealerName",
         d.customer_type AS "customerType",
         COALESCE((SELECT SUM(rp.amount - rp.amount_refunded)::float8
                     FROM razorpay_payments rp
                    WHERE rp.order_id = o.id AND rp.kind='order_payment'
                      AND rp.status IN ('paid','refunded')), 0) AS "onlinePaid",
         (SELECT count(*)::int FROM dealer_ledger dl WHERE dl.reference_id = o.id) AS "ledgerRows"
    FROM orders o
    JOIN dealers d ON d.id = o.dealer_id
   WHERE o.delivery_date >= ${today}::date - 1
     AND o.status <> 'cancelled'
   ORDER BY o.created_at DESC
   LIMIT 40
`) as any[];

console.log(`\n── dealer indents, last 2 days (${orders.length}) ──`);
let unpaidUpi = 0;
for (const o of orders) {
  const isUpi = o.mode === "upi";
  const unpaid = isUpi && o.onlinePaid <= 0.001;
  if (unpaid) unpaidUpi++;
  console.log(
    `  ${o.id.slice(0, 8)} ${(o.dealerCode ?? "-").padEnd(6)} ${String(o.dealerName ?? "").slice(0, 20).padEnd(22)} ` +
    `₹${String(o.total).padEnd(9)} mode=${o.mode.padEnd(8)} status=${o.status.padEnd(11)} ` +
    `onlinePaid=₹${o.onlinePaid} ledger=${o.ledgerRows}${unpaid ? "  ⚠ UPI BUT NOTHING CAPTURED" : ""}`
  );
}
console.log(`\n  upi orders with nothing captured: ${unpaidUpi}`);

// ── Payment-mode mix, to see which rail the complaint is about ──
const mix = (await pgClient`
  SELECT payment_mode::text AS mode, status::text AS status, count(*)::int AS n
    FROM orders
   WHERE delivery_date >= ${today}::date - 7
   GROUP BY 1,2 ORDER BY 1,2
`) as any[];
console.log("\n── indent payment modes, last 7 days ──");
for (const m of mix) console.log(`  ${m.mode.padEnd(10)} ${m.status.padEnd(12)} ${m.n}`);

await pgClient.end();
