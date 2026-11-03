// READ ONLY. Timeline of the orders/sales that pushed FGS stock below zero
// (found by diag-negative-stock.ts), plus the stored-vs-derived opening check
// that script timed out on.
//
// USAGE (from apps/api):  npx tsx src/diag-negative-stock-culprits.ts
import { pgClient } from "./lib/db.js";

const ORDER_PREFIXES = ["c4796159", "fd510f61", "a54c31a8", "c902bd8c", "3eba61b8"];

await pgClient.begin("READ ONLY", async (_tx) => {
  const sql = _tx as unknown as typeof pgClient;

  for (const pfx of ORDER_PREFIXES) {
    const [o] = (await sql`
      SELECT o.id::text, o.status::text, o.payment_mode::text AS pay, o.stock_deducted,
             o.delivery_date::text AS dd, o.created_at, o.confirmed_at, o.cancelled_at,
             o.cancellation_reason, o.cancel_window_ends_at, o.placed_by, o.updated_at,
             d.name AS dealer
        FROM orders o JOIN dealers d ON d.id = o.dealer_id
       WHERE o.id::text LIKE ${pfx + "%"}
    `) as any[];
    if (!o) { console.log(`\n${pfx}: not found`); continue; }
    console.log(`\n══ order ${o.id}  (${o.dealer}) ══`);
    console.log(`  status=${o.status} pay=${o.pay} deducted=${o.stock_deducted} delivery=${o.dd}`);
    console.log(`  created=${t(o.created_at)} confirmed=${t(o.confirmed_at)} cancel_window_ends=${t(o.cancel_window_ends_at)}`);
    console.log(`  cancelled_at=${t(o.cancelled_at)} reason=${o.cancellation_reason ?? "—"} updated=${t(o.updated_at)}`);
    // A revive stamps cancel_window_ends_at = now() at the revive moment and
    // clears cancelled_at — so window_end == confirm-ish time, not +30 min.
    const rp = (await sql`
      SELECT status::text, kind::text, amount, created_at, updated_at,
             razorpay_payment_id AS pid
        FROM razorpay_payments WHERE order_id = ${o.id}::uuid ORDER BY created_at
    `) as any[];
    for (const r of rp)
      console.log(`  rzp ${r.kind} ${r.status} ₹${r.amount} created=${t(r.created_at)} updated=${t(r.updated_at)} ${r.pid ?? ""}`);
    const items = (await sql`
      SELECT oi.product_name, oi.quantity, oi.created_at FROM order_items oi
       WHERE oi.order_id = ${o.id}::uuid ORDER BY oi.product_name
    `) as any[];
    for (const i of items) console.log(`    item ${String(i.product_name).padEnd(30)} qty=${i.quantity} at=${t(i.created_at)}`);
    // Sibling orders for the same dealer/day (supersede / re-place history)
    const sib = (await sql`
      SELECT left(o2.id::text, 8) AS id, o2.status::text, o2.payment_mode::text AS pay,
             o2.stock_deducted, o2.created_at, o2.cancelled_at, o2.cancellation_reason
        FROM orders o2
       WHERE o2.dealer_id = (SELECT dealer_id FROM orders WHERE id = ${o.id}::uuid)
         AND o2.delivery_date = ${o.dd}::date AND o2.id <> ${o.id}::uuid
       ORDER BY o2.created_at
    `) as any[];
    for (const s of sib)
      console.log(`  sibling ${s.id} ${s.status} ${s.pay} deducted=${s.stock_deducted} created=${t(s.created_at)} cancelled=${t(s.cancelled_at)} ${s.cancellation_reason ?? ""}`);
  }

  // Direct sale GP-0051
  const gp = (await sql`
    SELECT gp_no, sale_date::text, status::text, created_at, updated_at, customer_type::text
      FROM direct_sales WHERE gp_no = 'GP-0051'
  `) as any[];
  for (const g of gp)
    console.log(`\n══ ${g.gp_no} ══ sale_date=${g.sale_date} status=${g.status} type=${g.customer_type} created=${t(g.created_at)} updated=${t(g.updated_at)}`);

  // Orders that are live + paid but were cancelled at some point (revived).
  const revived = (await sql`
    SELECT o.delivery_date::text AS dd, left(o.id::text, 8) AS id, o.created_at, o.confirmed_at,
           o.cancel_window_ends_at
      FROM orders o
     WHERE o.payment_mode = 'upi' AND o.status <> 'cancelled'
       AND o.delivery_date >= DATE '2026-10-01'
       AND o.cancel_window_ends_at IS NOT NULL AND o.confirmed_at IS NOT NULL
       AND abs(extract(epoch FROM o.cancel_window_ends_at - o.confirmed_at)) < 5
     ORDER BY o.delivery_date, o.created_at
  `) as any[];
  console.log(`\n── live UPI orders since 10-01 with zero cancel grace (revived or worker-confirmed): ${revived.length}`);
  for (const r of revived) console.log(`  ${r.dd} ${r.id} created=${t(r.created_at)} confirmed=${t(r.confirmed_at)}`);
});

// Stored opening vs derived — one fgs_day() per date, outside the tx timeout.
const drift = (await pgClient`
  WITH dates AS (
    SELECT DISTINCT date FROM fgs_stock_log
     WHERE date >= (SELECT MIN(date) FROM fgs_stock_log WHERE opening_manual)
       AND date >= DATE '2026-09-20'
  )
  SELECT f.date::text AS date, p.code, p.name, f.opening AS stored, fd.opening AS derived
    FROM dates s
    CROSS JOIN LATERAL fgs_day(s.date) fd
    JOIN fgs_stock_log f ON f.product_id = fd.product_id AND f.date = s.date
    JOIN products p ON p.id = f.product_id
   WHERE NOT f.opening_manual AND f.opening <> fd.opening
   ORDER BY p.code, f.date
`) as any[];
console.log(`\n── stored opening ≠ derived opening since 2026-09-20: ${drift.length} rows ──`);
for (const d of drift.slice(0, 40))
  console.log(`  ${d.date} ${d.code} ${String(d.name).padEnd(30)} stored=${d.stored} derived=${d.derived}`);

await pgClient.end();

function t(x: any): string {
  return x ? new Date(x).toLocaleString("sv-SE", { timeZone: "Asia/Kolkata" }) : "—";
}
