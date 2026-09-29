import { pgClient } from "./lib/db.js";
import { isCreditSupplyOrder } from "./lib/credit-check.js";
async function main() {
  // Every (date, route, dealer) with more than one order, and how many rails
  // the route sheet would open for it.
  const rows = await pgClient`
    SELECT o.delivery_date::text AS dd, COALESCE(o.route_id, d.route_id)::text AS route,
           d.code, d.name, d.customer_type::text AS ct,
           array_agg(o.payment_mode::text) AS modes, count(*)::int AS orders
      FROM orders o JOIN dealers d ON d.id = o.dealer_id
     WHERE o.status IN ('confirmed','dispatched','delivered')
     GROUP BY 1,2,3,4,5 HAVING count(*) > 1
  ` as any[];
  let multi = 0, split = 0;
  const splits: string[] = [];
  for (const r of rows) {
    multi++;
    const rails = new Set(r.modes.map((m: string) =>
      isCreditSupplyOrder({ customerType: r.ct, paymentMode: m })));
    if (rails.size > 1) { split++; splits.push(`  ${r.dd} ${r.code} ${r.name} [${r.modes.join(",")}] ${r.ct}`); }
  }
  console.log(`(date, route, dealer) groups with >1 order: ${multi}`);
  console.log(`  of those, SPLIT into two rows: ${split}`);
  console.log(`  of those, stay on ONE row:     ${multi - split}`);
  console.log("\nsplit rows:");
  for (const s of splits) console.log(s);
  await pgClient.end();
}
main().catch(async (e) => { console.error(e); await pgClient.end(); process.exit(1); });
