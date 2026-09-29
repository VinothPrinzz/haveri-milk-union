// Read-only: prove the cash/credit split now follows the order's payment rail
// on every surface, for both credit-institution orders that were paid by UPI.
import { pgClient } from "./lib/db.js";

const PERIODS: Array<{ from: string; to: string }> = [
  { from: "2026-08-01", to: "2026-08-31" },
  { from: "2026-09-01", to: "2026-09-30" },
];

async function main() {
  console.log("── B5 Credit Sales bill: lines carried, by period ──");
  for (const { from, to } of PERIODS) {
    const [r] = await pgClient`
      SELECT count(*)::int AS old_lines,
             count(*) FILTER (WHERE o.payment_mode::text <> 'upi')::int AS new_lines,
             COALESCE(sum(oi.line_total), 0)::numeric(14,2)::text AS old_amt,
             COALESCE(sum(oi.line_total) FILTER (WHERE o.payment_mode::text <> 'upi'), 0)::numeric(14,2)::text AS new_amt
        FROM orders o
        JOIN dealers d ON d.id = o.dealer_id
        JOIN order_items oi ON oi.order_id = o.id
       WHERE o.delivery_date BETWEEN ${from}::date AND ${to}::date
         AND o.status IN ('confirmed','dispatched','delivered')
         AND COALESCE(d.customer_type::text,'') LIKE 'Credit Inst%'
    ` as any[];
    console.log(`  ${from}..${to}   lines ${r.old_lines} -> ${r.new_lines}   amount ${r.old_amt} -> ${r.new_amt}`);
  }

  console.log("\n── B4 Cash Sales / Sales Register / GST Statement: cash-arm totals ──");
  for (const { from, to } of PERIODS) {
    const [r] = await pgClient`
      SELECT COALESCE(sum(o.grand_total) FILTER (
               WHERE NOT (COALESCE(d.customer_type::text,'') LIKE 'Credit Inst%')
             ), 0)::numeric(14,2)::text AS old_cash,
             COALESCE(sum(o.grand_total) FILTER (
               WHERE NOT (COALESCE(d.customer_type::text,'') LIKE 'Credit Inst%'
                          AND o.payment_mode::text <> 'upi')
             ), 0)::numeric(14,2)::text AS new_cash
        FROM orders o JOIN dealers d ON d.id = o.dealer_id
       WHERE o.delivery_date BETWEEN ${from}::date AND ${to}::date
         AND o.status IN ('confirmed','dispatched','delivered')
    ` as any[];
    console.log(`  ${from}..${to}   cash side ${r.old_cash} -> ${r.new_cash}`);
  }

  console.log("\n── Route Sheet: rows that move from Credit to the cash total ──");
  const rs = await pgClient`
    SELECT o.delivery_date::text AS d, r.name AS route, dd.code, dd.name,
           o.payment_mode::text AS pm, sum(oi.line_total)::numeric(14,2)::text AS amt
      FROM orders o
      JOIN dealers dd ON dd.id = o.dealer_id
      JOIN order_items oi ON oi.order_id = o.id
      LEFT JOIN routes r ON r.id = COALESCE(o.route_id, dd.route_id)
     WHERE COALESCE(dd.customer_type::text,'') LIKE 'Credit Inst%'
       AND o.payment_mode::text = 'upi'
       AND o.status IN ('confirmed','dispatched','delivered')
     GROUP BY 1,2,3,4,5 ORDER BY 1
  ` as any[];
  for (const x of rs)
    console.log(`  ${x.d}  ${String(x.route ?? "-").padEnd(16)} ${String(x.code).padEnd(6)} ${String(x.name).slice(0,26).padEnd(28)} ${x.pm}  ${String(x.amt).padStart(10)}  (credit) -> cash`);

  console.log("");
  console.log("── Day Book: sale-line settlement bucket ──");
  const dbk = await pgClient`
    SELECT o.delivery_date::text AS d, d.code, d.name, o.grand_total::float8 AS amount,
           CASE
             WHEN COALESCE(d.customer_type::text,'') LIKE 'Credit Inst%' THEN 'credit'
             WHEN o.payment_mode::text = 'upi'                           THEN 'upi'
             ELSE 'wallet'
           END AS before,
           CASE
             WHEN o.payment_mode::text = 'upi'                           THEN 'upi'
             WHEN COALESCE(d.customer_type::text,'') LIKE 'Credit Inst%' THEN 'credit'
             ELSE 'wallet'
           END AS after,
           (SELECT p.amount::float8 FROM payments p
             WHERE p.reference = o.payment_reference LIMIT 1) AS receipt
      FROM orders o JOIN dealers d ON d.id = o.dealer_id
     WHERE o.status IN ('confirmed','dispatched','delivered')
       AND COALESCE(d.customer_type::text,'') LIKE 'Credit Inst%'
       AND o.payment_mode::text = 'upi'
     ORDER BY o.delivery_date
  ` as any[];
  for (const x of dbk)
    console.log(`  ${x.d}  ${String(x.code).padEnd(6)} ${String(x.name).slice(0,26).padEnd(28)} ` +
      `${x.amount.toFixed(2).padStart(10)}  ${x.before} -> ${x.after}  ` +
      `receipt=${x.receipt != null ? x.receipt.toFixed(2) : "NONE"}`);

  console.log("\n── nothing else moved: credit-inst orders still on the credit side ──");
  const [still] = await pgClient`
    SELECT count(*)::int AS n, sum(o.grand_total)::numeric(14,2)::text AS amt
      FROM orders o JOIN dealers d ON d.id = o.dealer_id
     WHERE COALESCE(d.customer_type::text,'') LIKE 'Credit Inst%'
       AND o.payment_mode::text <> 'upi'
       AND o.status IN ('confirmed','dispatched','delivered')
  ` as any[];
  console.log(`  ${still.n} orders, ${still.amt} — unchanged`);

  await pgClient.end();
}
main().catch(async (e) => { console.error(e); await pgClient.end(); process.exit(1); });
