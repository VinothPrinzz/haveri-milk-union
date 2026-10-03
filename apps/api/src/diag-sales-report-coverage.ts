// ═══════════════════════════════════════════════════════════════════════
// diag-sales-report-coverage.ts — READ ONLY.
//
// Sizes what each sales report leaves out, against its stated purpose.
// Three sales rails exist (orders / direct_sales / employee_orders) and most
// reports read only some of them; this measures the money that falls through.
//
// USAGE (from apps/api):  npx tsx src/diag-sales-report-coverage.ts [days]
// ═══════════════════════════════════════════════════════════════════════

import { pgClient } from "./lib/db.js";

const days = Number(process.argv[2] ?? 30);
const inr = (n: any) => "₹" + (Number(n) || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function main() {
  const [r] = await pgClient`
    SELECT (CURRENT_DATE - ${days}::int)::text AS from, CURRENT_DATE::text AS to
  `;
  const from = (r as any).from, to = (r as any).to;
  console.log(`Range ${from} .. ${to}\n`);

  // ── 0. The cash_payment_modes setting B4 filters on ──
  const [cfg] = await pgClient`
    SELECT value::text AS v FROM system_settings
    WHERE category = 'reports' AND key = 'cash_payment_modes'
  `;
  console.log(`system_settings reports.cash_payment_modes = ${(cfg as any)?.v ?? "(unset → default ['cash','upi','wallet'])"}\n`);

  // ── 1. Dealer orders by payment_mode (what B4's filter keeps/drops) ──
  console.log("── Dealer orders by payment_mode (non-credit-institution) ──");
  console.table((await pgClient`
    SELECT o.payment_mode::text AS pm, count(*)::int AS n, SUM(o.grand_total)::numeric AS amt
    FROM orders o JOIN dealers d ON d.id = o.dealer_id
    WHERE o.delivery_date >= ${from}::date AND o.delivery_date <= ${to}::date
      AND o.created_at >= ${from}::date - interval '31 days'
      AND o.created_at <  ${to}::date + interval '2 days'
      AND o.status IN ('confirmed','dispatched','delivered')
      AND COALESCE(d.customer_type::text,'') NOT LIKE 'Credit Inst%'
    GROUP BY 1 ORDER BY 3 DESC
  `).map((x: any) => ({ payment_mode: x.pm, orders: x.n, amount: inr(x.amt) })));

  // ── 2. Credit-institution orders (B5's population) by payment_mode ──
  console.log("── Credit-institution orders by payment_mode ──");
  const ci = await pgClient`
    SELECT o.payment_mode::text AS pm, count(*)::int AS n, SUM(o.grand_total)::numeric AS amt
    FROM orders o JOIN dealers d ON d.id = o.dealer_id
    WHERE o.delivery_date >= ${from}::date AND o.delivery_date <= ${to}::date
      AND o.created_at >= ${from}::date - interval '31 days'
      AND o.created_at <  ${to}::date + interval '2 days'
      AND o.status IN ('confirmed','dispatched','delivered')
      AND COALESCE(d.customer_type::text,'') LIKE 'Credit Inst%'
    GROUP BY 1 ORDER BY 3 DESC
  `;
  console.table((ci as any[]).map(x => ({ payment_mode: x.pm, orders: x.n, amount: inr(x.amt) })));
  console.log(`  (rows above with a cash-like mode leak into B4 Cash Sales, which applies no customer filter)\n`);

  // ── 3. Direct sales: routed vs route-less ──
  // B6 Sales Register and B4's would-be direct arm both require route_id NOT
  // NULL, so route-less counter sales never reach either.
  console.log("── Direct sales: routed vs route-less (status='confirmed') ──");
  console.table((await pgClient`
    SELECT ds.customer_type::text AS type,
           CASE WHEN ds.route_id IS NULL THEN 'route-less' ELSE 'routed' END AS routing,
           count(*)::int AS n, SUM(ds.grand_total)::numeric AS amt
    FROM direct_sales ds
    WHERE ds.sale_date >= ${from}::date AND ds.sale_date <= ${to}::date
      AND ds.status = 'confirmed'
    GROUP BY 1,2 ORDER BY 1,2
  `).map((x: any) => ({ type: x.type, routing: x.routing, n: x.n, amount: inr(x.amt) })));

  // ── 4. Employee subsidy: the rail split at 2026-08-02 ──
  console.log("── Employee subsidy by rail ──");
  console.table((await pgClient`
    SELECT 'employee_orders' AS rail, eo.status::text AS status,
           count(*)::int AS n, SUM(eo.grand_total)::numeric AS amt
    FROM employee_orders eo
    WHERE eo.delivery_date >= ${from}::date AND eo.delivery_date <= ${to}::date
    GROUP BY 1,2
    UNION ALL
    SELECT 'direct_sales (legacy)', ds.status::text,
           count(*)::int, SUM(ds.grand_total)::numeric
    FROM direct_sales ds
    WHERE ds.customer_type = 'employee_subsidy'
      AND ds.sale_date >= ${from}::date AND ds.sale_date <= ${to}::date
    GROUP BY 1,2 ORDER BY 1,2
  `).map((x: any) => ({ rail: x.rail, status: x.status, n: x.n, amount: inr(x.amt) })));

  // ── 5. Adhoc Sales: rows whose customer_name resolves to NULL ──
  // The CASE only covers 'agent' and 'cash', so vip_sample and
  // employee_subsidy rows print a blank customer.
  const [blank] = await pgClient`
    SELECT count(*)::int AS n
    FROM direct_sales ds
    WHERE ds.sale_date >= ${from}::date AND ds.sale_date <= ${to}::date
      AND ds.status = 'confirmed'
      AND ds.customer_type NOT IN ('agent','cash')
  `;
  console.log(`Adhoc Sales rows that render a blank customer name: ${(blank as any).n}\n`);

  await pgClient.end();
}

main().catch(e => { console.error(e); process.exit(1); });
