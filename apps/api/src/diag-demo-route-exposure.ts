// ═══════════════════════════════════════════════════════════════════════
// diag-demo-route-exposure.ts — READ ONLY.
//
// What the Play Store DEMO route was contributing to the sales reports
// before it was filtered out, per rail and per month. Run it again after a
// review cycle to see what the reviewer's test orders would have added.
//
// USAGE (from apps/api):  npx tsx src/diag-demo-route-exposure.ts
// ═══════════════════════════════════════════════════════════════════════
import { pgClient } from "./lib/db.js";

async function main() {
  const routes = await pgClient`
    SELECT id, code, name, active, deleted_at
      FROM routes WHERE code = 'DEMO'
  `;
  if (routes.length === 0) {
    console.log("No DEMO route in this database — nothing to exclude.");
    return;
  }
  for (const r of routes) {
    console.log(`DEMO route  ${r.id}  "${r.name}"  active=${r.active}  deleted=${r.deleted_at ?? "no"}`);
  }

  const dealers = await pgClient`
    SELECT d.id, d.code, d.name, d.phone
      FROM dealers d
      JOIN routes r ON r.id = d.route_id
     WHERE r.code = 'DEMO' AND d.deleted_at IS NULL
  `;
  console.log(`\nDealers parked on it: ${dealers.length}`);
  for (const d of dealers) console.log(`  ${d.code ?? "(no code)"}  ${d.name}  ${d.phone}`);

  // Same route resolution the reports use: order snapshot first, dealer's
  // route as fallback.
  const orders = await pgClient`
    SELECT to_char(o.delivery_date, 'YYYY-MM') AS month,
           COUNT(DISTINCT o.id)::int AS orders,
           COALESCE(SUM(oi.quantity), 0)::int AS packets,
           COALESCE(SUM(oi.line_total), 0)::numeric AS amount
      FROM orders o
      JOIN dealers d      ON d.id = o.dealer_id
      JOIN order_items oi ON oi.order_id = o.id
     WHERE o.status IN ('confirmed', 'dispatched', 'delivered')
       AND EXISTS (SELECT 1 FROM routes dr WHERE dr.code = 'DEMO'
                    AND dr.id = COALESCE(o.route_id, d.route_id))
     GROUP BY 1 ORDER BY 1
  `;

  const direct = await pgClient`
    SELECT to_char(ds.sale_date, 'YYYY-MM') AS month,
           COUNT(DISTINCT ds.id)::int AS sales,
           COALESCE(SUM(dsi.quantity), 0)::int AS packets,
           COALESCE(SUM(dsi.line_total), 0)::numeric AS amount
      FROM direct_sales ds
      JOIN direct_sale_items dsi ON dsi.direct_sale_id = ds.id
     WHERE ds.status = 'confirmed'
       AND EXISTS (SELECT 1 FROM routes dr WHERE dr.code = 'DEMO' AND dr.id = ds.route_id)
     GROUP BY 1 ORDER BY 1
  `;

  const employee = await pgClient`
    SELECT to_char(eo.delivery_date, 'YYYY-MM') AS month,
           COUNT(DISTINCT eo.id)::int AS indents,
           COALESCE(SUM(eoi.quantity), 0)::int AS packets,
           COALESCE(SUM(eoi.line_total), 0)::numeric AS amount
      FROM employee_orders eo
      JOIN employee_order_items eoi ON eoi.employee_order_id = eo.id
     WHERE eo.status IN ('confirmed', 'dispatched', 'delivered')
       AND EXISTS (SELECT 1 FROM routes dr WHERE dr.code = 'DEMO' AND dr.id = eo.route_id)
     GROUP BY 1 ORDER BY 1
  `;

  const show = (label: string, rows: any[], countKey: string) => {
    console.log(`\n${label}`);
    if (rows.length === 0) { console.log("  (nothing)"); return; }
    for (const r of rows) {
      console.log(`  ${r.month}  ${String(r[countKey]).padStart(4)} ${countKey}  ` +
                  `${String(r.packets).padStart(6)} pkts  Rs ${Number(r.amount).toFixed(2)}`);
    }
  };
  show("orders rail (dealer indents)", orders as any[], "orders");
  show("direct_sales rail (counter / gate pass)", direct as any[], "sales");
  show("employee_orders rail (subsidy)", employee as any[], "indents");

  await pgClient.end();
}

main().catch(async (e) => { console.error(e); await pgClient.end(); process.exit(1); });
