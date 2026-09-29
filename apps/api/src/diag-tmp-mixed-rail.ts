import { pgClient } from "./lib/db.js";
async function main() {
  console.log("── dealers with BOTH a upi and a non-upi order on the same delivery date + route ──");
  const rows = await pgClient`
    SELECT o.delivery_date::text AS dd, COALESCE(o.route_id, d.route_id)::text AS route,
           r.name AS route_name, d.code, d.name, d.customer_type::text AS ct,
           count(*)::int AS orders,
           count(*) FILTER (WHERE o.payment_mode::text = 'upi')::int AS upi_orders,
           count(*) FILTER (WHERE o.payment_mode::text <> 'upi')::int AS other_orders,
           sum(o.grand_total) FILTER (WHERE o.payment_mode::text = 'upi')::numeric(12,2)::text AS upi_amt,
           sum(o.grand_total) FILTER (WHERE o.payment_mode::text <> 'upi')::numeric(12,2)::text AS other_amt
      FROM orders o
      JOIN dealers d ON d.id = o.dealer_id
      LEFT JOIN routes r ON r.id = COALESCE(o.route_id, d.route_id)
     WHERE o.status IN ('confirmed','dispatched','delivered')
     GROUP BY 1,2,3,4,5,6
    HAVING count(*) FILTER (WHERE o.payment_mode::text = 'upi') > 0
       AND count(*) FILTER (WHERE o.payment_mode::text <> 'upi') > 0
     ORDER BY 1 DESC
  ` as any[];
  if (!rows.length) console.log("  none");
  for (const x of rows)
    console.log(`  ${x.dd}  ${String(x.route_name ?? "-").padEnd(16)} ${String(x.code).padEnd(6)} ${String(x.name).slice(0,26).padEnd(28)} ${x.ct.padEnd(20)} ${x.orders} orders: upi ${x.upi_orders} (${x.upi_amt}) + other ${x.other_orders} (${x.other_amt})`);

  console.log("\n── P45's orders in detail ──");
  const p45 = await pgClient`
    SELECT o.id::text AS id, o.delivery_date::text AS dd, o.payment_mode::text AS pm,
           o.grand_total::text AS total, o.status::text AS st,
           COALESCE(o.route_id, d.route_id)::text AS route, r.name AS route_name
      FROM orders o JOIN dealers d ON d.id = o.dealer_id
      LEFT JOIN routes r ON r.id = COALESCE(o.route_id, d.route_id)
     WHERE d.code = 'P45' ORDER BY o.delivery_date
  ` as any[];
  for (const x of p45)
    console.log(`  ${x.dd}  ${x.pm.padEnd(7)} ${String(x.total).padStart(10)}  ${x.st.padEnd(11)} ${x.route_name}  ${x.id.slice(0,8)}`);
  await pgClient.end();
}
main().catch(async (e) => { console.error(e); await pgClient.end(); process.exit(1); });
