// ═══════════════════════════════════════════════════════════════════════
// diag-verify-counter-qr-dedupe.ts   (READ ONLY)
//
// Counter QR money was counted twice: once off razorpay_payments (Day Book
// old §1c / statement old §2b) and once more off the `payments` receipt
// applyPaidGatePassPayment now books, which no classifier could tie back to
// its gate pass and so fell into the 'on_account' bucket.
//
// Replays the FIXED Day Book section-1 classifier over real rows and shows
// the receipts breakdown per day, plus the statement's double-credit.
//   npx tsx src/diag-verify-counter-qr-dedupe.ts [YYYY-MM-DD]
// ═══════════════════════════════════════════════════════════════════════
import { pgClient } from "./lib/db.js";

const date = process.argv[2] ?? "2026-08-20";

const rows = (await pgClient`
  SELECT
    CASE
      WHEN dl.reference_type = 'wallet_topup' THEN 'topup'
      WHEN dl.reference_type = 'order'        THEN 'order_payment'
      WHEN rp.kind = 'credit_topup'           THEN 'topup'
      WHEN rp.kind = 'gate_pass'              THEN 'counter_collection'
      WHEN rp.kind = 'order_payment'          THEN 'order_payment'
      WHEN gp.gp_no IS NOT NULL               THEN 'counter_cash'
      WHEN p.invoice_id IS NOT NULL           THEN 'invoice_payment'
      ELSE 'on_account'
    END AS type,
    p.amount::float8 AS amount,
    COALESCE(i.invoice_number, gp.gp_no) AS "docNo",
    u.name AS "byName",
    COALESCE(ord.route_id, gp.route_id,
             CASE WHEN gp.id IS NULL THEN d.route_id END)::text AS "routeId"
  FROM payments p
  JOIN dealers d ON d.id = p.dealer_id
  LEFT JOIN invoices i ON i.id = p.invoice_id
  LEFT JOIN LATERAL (
    SELECT l.reference_type::text AS reference_type FROM dealer_ledger l
     WHERE l.reference_id = p.id AND l.type = 'credit' ORDER BY l.created_at LIMIT 1) dl ON true
  LEFT JOIN LATERAL (
    SELECT x.kind::text AS kind, x.order_id, x.direct_sale_id FROM razorpay_payments x
     WHERE p.reference IS NOT NULL AND x.razorpay_payment_id = p.reference LIMIT 1) rp ON true
  LEFT JOIN LATERAL (
    SELECT o.route_id FROM orders o WHERE o.id = COALESCE(rp.order_id, i.order_id) LIMIT 1) ord ON true
  LEFT JOIN LATERAL (
    SELECT ds.id, ds.gp_no, ds.route_id, ds.officer_id FROM direct_sales ds
     WHERE ds.gp_no IS NOT NULL
       AND (ds.id = rp.direct_sale_id
         OR (ds.customer_type = 'agent' AND ds.gp_no = p.reference)) LIMIT 1) gp ON true
  LEFT JOIN users u ON u.id = COALESCE(p.received_by, gp.officer_id)
  WHERE p.received_date = ${date}::date
`) as any[];

const byType: Record<string, { n: number; total: number }> = {};
for (const r of rows) {
  const b = (byType[r.type] ??= { n: 0, total: 0 });
  b.n += 1; b.total += r.amount;
}
const total = rows.reduce((s, r) => s + r.amount, 0);
console.log(`\nDay Book receipts for ${date} — ONE rail (payments)`);
console.table(byType);
console.log(`  totalReceipts: Rs.${total.toFixed(2)}`);
const qr = rows.filter((r) => r.type === "counter_collection");
console.log(`  counter QR lines now carry docNo/by/route:`);
console.table(qr.map((r) => ({ docNo: r.docNo, by: r.byName, route: r.routeId ?? "(unassigned)", amount: r.amount })));

const dbl = (await pgClient`
  SELECT p.received_date::text AS day, COUNT(*)::int AS passes, SUM(p.amount)::float8 AS "wasDoubleCounted"
    FROM payments p
    JOIN razorpay_payments x ON x.razorpay_payment_id = p.reference AND x.kind = 'gate_pass'
   GROUP BY 1 ORDER BY 1
`) as any[];
console.log(`\nRemoved from every day's inflated total:`);
console.table(dbl);
console.log(`  grand total: Rs.${dbl.reduce((s, r) => s + r.wasDoubleCounted, 0).toFixed(2)}`);

const stmt = (await pgClient`
  SELECT d.code, d.name, SUM(p.amount)::float8 AS "overcredited"
    FROM payments p
    JOIN razorpay_payments x ON x.razorpay_payment_id = p.reference AND x.kind = 'gate_pass'
    JOIN dealers d ON d.id = p.dealer_id
   GROUP BY 1, 2 ORDER BY 3 DESC
`) as any[];
console.log(`\nDealer Statements: closing balance was over-credited by`);
console.table(stmt);
await pgClient.end();
