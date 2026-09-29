// ═══════════════════════════════════════════════════════════════════════
// diag-day-route-cash-gap.ts — READ ONLY.
//
// Sizes the hole in B2 Day/Route Wise Cash Sales: it read the `orders` rail
// alone, so counter sales, gate passes and employee-subsidy indents never
// reached any route column. Prints, per day, what the old query returned
// against each rail it was missing.
//
// USAGE (from apps/api):  npx tsx src/diag-day-route-cash-gap.ts [days]
// ═══════════════════════════════════════════════════════════════════════

import { pgClient } from "./lib/db.js";

const ADHOC = "00000000-0000-0000-0000-000000000000";
const days = Number(process.argv[2] ?? 14);

const inr = (n: any) => "₹" + (Number(n) || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pad = (s: string, w: number) => s.padStart(w);

async function main() {
  const [range] = await pgClient`
    SELECT (CURRENT_DATE - ${days}::int)::text AS from, CURRENT_DATE::text AS to
  `;
  const from = (range as any).from, to = (range as any).to;
  console.log(`Range ${from} .. ${to}\n`);

  const rows = await pgClient`
    WITH combined AS (
      SELECT o.delivery_date AS sale_date, 'orders' AS rail,
             COALESCE(o.route_id, d.route_id, ${ADHOC}::uuid) AS route_id,
             o.grand_total::numeric AS amount
      FROM orders o
      JOIN dealers d ON d.id = o.dealer_id
      WHERE o.delivery_date >= ${from}::date
        AND o.delivery_date <= ${to}::date
        AND o.created_at >= ${from}::date - interval '31 days'
        AND o.created_at <  ${to}::date + interval '2 days'
        AND o.status IN ('confirmed', 'dispatched', 'delivered')
        AND COALESCE(d.customer_type::text, '') NOT LIKE 'Credit Inst%'
      UNION ALL
      SELECT ds.sale_date,
             'ds:' || ds.customer_type::text || '/' || ds.payment_mode::text,
             COALESCE(ds.route_id, ${ADHOC}::uuid), ds.grand_total::numeric
      FROM direct_sales ds
      WHERE ds.sale_date >= ${from}::date
        AND ds.sale_date <= ${to}::date
        AND ds.status = 'confirmed'
      UNION ALL
      SELECT eo.delivery_date, 'emp_orders/' || eo.payment_mode::text,
             COALESCE(eo.route_id, ${ADHOC}::uuid), eo.grand_total::numeric
      FROM employee_orders eo
      WHERE eo.delivery_date >= ${from}::date
        AND eo.delivery_date <= ${to}::date
        AND eo.status IN ('confirmed', 'dispatched', 'delivered')
    )
    SELECT to_char(sale_date, 'YYYY-MM-DD') AS date, rail,
           count(*)::int AS n,
           SUM(amount)::numeric AS amount,
           SUM(amount) FILTER (WHERE route_id = ${ADHOC}::uuid)::numeric AS adhoc_amount
    FROM combined
    GROUP BY sale_date, rail
    ORDER BY 1, 2
  `;

  const rails = [...new Set((rows as any[]).map(r => r.rail))].sort();
  const dates = [...new Set((rows as any[]).map(r => r.date))].sort();
  const cell = new Map((rows as any[]).map(r => [`${r.date}|${r.rail}`, r]));

  console.log(["Date".padEnd(12), ...rails.map(r => pad(r.slice(0, 22), 22))].join(" "));
  const totals: Record<string, number> = {};
  let adhocTotal = 0;
  for (const d of dates) {
    const line = [d.padEnd(12)];
    for (const rail of rails) {
      const c = cell.get(`${d}|${rail}`);
      const amt = Number(c?.amount ?? 0);
      totals[rail] = (totals[rail] ?? 0) + amt;
      adhocTotal += Number(c?.adhoc_amount ?? 0);
      line.push(pad(amt ? inr(amt) : "-", 22));
    }
    console.log(line.join(" "));
  }
  console.log(["TOTAL".padEnd(12), ...rails.map(r => pad(inr(totals[r] ?? 0), 22))].join(" "));

  // A rail counts on B2 only if money actually moved on it. 'credit' on a
  // direct sale or an employee indent means nothing was collected (the
  // employee subsidy is recovered from salary, off-system), so those sit on
  // the Employee Credit / Credit Sales side instead.
  const isCollected = (rail: string) =>
    rail === "orders" || /\/(cash|upi|wallet)$/.test(rail);

  const old = totals["orders"] ?? 0;
  const counted = Object.entries(totals)
    .filter(([rail]) => isCollected(rail))
    .reduce((s, [, v]) => s + v, 0);
  const excluded = Object.entries(totals)
    .filter(([rail]) => !isCollected(rail))
    .map(([rail, v]) => `${rail} ${inr(v)}`);

  console.log(`\nOld report (orders only): ${inr(old)}`);
  console.log(`Now (collected rails):    ${inr(counted)}`);
  console.log(`Added:                    ${inr(counted - old)}  (${old ? (((counted - old) / old) * 100).toFixed(3) : "-"}% of the old total)`);
  console.log(`Excluded as credit:       ${excluded.length ? excluded.join(", ") : "none"}`);
  console.log(`Route-less money seen on all rails (ADHOC column): ${inr(adhocTotal)}`);

  // Money the old query dropped for a different reason: a route-less dealer
  // order, and sales on routes the old query's active-only filter hid.
  const [hidden] = await pgClient`
    SELECT COALESCE(SUM(o.grand_total) FILTER (
             WHERE COALESCE(o.route_id, d.route_id) IS NULL), 0)::numeric AS no_route,
           COALESCE(SUM(o.grand_total) FILTER (
             WHERE r.id IS NOT NULL AND (r.deleted_at IS NOT NULL OR r.active = false)), 0)::numeric AS dead_route
    FROM orders o
    JOIN dealers d ON d.id = o.dealer_id
    LEFT JOIN routes r ON r.id = COALESCE(o.route_id, d.route_id)
    WHERE o.delivery_date >= ${from}::date
      AND o.delivery_date <= ${to}::date
      AND o.created_at >= ${from}::date - interval '31 days'
      AND o.created_at <  ${to}::date + interval '2 days'
      AND o.status IN ('confirmed', 'dispatched', 'delivered')
      AND COALESCE(d.customer_type::text, '') NOT LIKE 'Credit Inst%'
  `;
  console.log(`\nDealer orders with no route at all:        ${inr((hidden as any).no_route)}`);
  console.log(`Dealer orders on retired/deleted routes:   ${inr((hidden as any).dead_route)}  (had no column, but sat in the day total)`);

  await pgClient.end();
}

main().catch(e => { console.error(e); process.exit(1); });
