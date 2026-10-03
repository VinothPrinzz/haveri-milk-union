// Read-only: how does HTM 1000ML (Subsidy) [PD0191S] carry stock today, and how
// does it land on the Dispatch Sheet vs the base SKU PD0191?
import { pgClient } from "./lib/db.js";

async function main() {
  const [{ d: today }] = await pgClient`
    SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS d
  ` as any[];
  console.log("today (IST):", today, "\n");

  const prods = await pgClient`
    SELECT p.id::text AS id, p.code, p.name, p.report_alias, p.unit,
           p.packets_crate, p.sort_order, p.print_direction,
           p.stock AS legacy_counter,
           p.stock_source_product_id::text AS stock_source,
           p.deleted_at
      FROM products p
     WHERE p.code IN ('PD0191','PD0191S')
     ORDER BY p.code
  ` as any[];
  console.log("── products ──");
  for (const r of prods) {
    console.log(`  ${r.code}  ${r.name}  alias=${r.report_alias}`);
    console.log(`    id=${r.id}  packets/crate=${r.packets_crate}  sort=${r.sort_order}  print=${r.print_direction}`);
    console.log(`    legacy products.stock=${r.legacy_counter}  stock_source=${r.stock_source ?? "(self)"}  deleted=${r.deleted_at ?? "no"}`);
  }

  const base = prods.find(p => p.code === "PD0191");
  const sub  = prods.find(p => p.code === "PD0191S");
  if (!base || !sub) { await pgClient.end(); return; }

  console.log("\n── fgs_day(today) rows ──");
  const day = await pgClient`
    SELECT p.code, d.opening, d.received, d.dispatched, d.wastage, d.closing
      FROM fgs_day(${today}::date) d
      JOIN products p ON p.id = d.product_id
     WHERE p.code IN ('PD0191','PD0191S')
     ORDER BY p.code
  ` as any[];
  for (const r of day) {
    console.log(`  ${r.code}: opening=${r.opening} received=${r.received} dispatched=${r.dispatched} wastage=${r.wastage} closing=${r.closing}`);
  }

  console.log("\n── fgs_available() ──");
  for (const p of [base, sub]) {
    const [a] = await pgClient`SELECT fgs_available(${p.id}::uuid, ${today}::date) AS a` as any[];
    console.log(`  ${p.code}: ${a.a}`);
  }

  console.log("\n── stored fgs_stock_log rows (latest 5 each) ──");
  for (const p of [base, sub]) {
    const rows = await pgClient`
      SELECT f.date::text AS date, f.opening, f.received, f.dispatched, f.wastage, f.closing, f.opening_manual
        FROM fgs_stock_log f WHERE f.product_id = ${p.id}::uuid
       ORDER BY f.date DESC LIMIT 5
    ` as any[];
    console.log(`  ${p.code}: ${rows.length} row(s)`);
    for (const r of rows) {
      console.log(`    ${r.date}  o=${r.opening} r=${r.received} d=${r.dispatched} w=${r.wastage} c=${r.closing} manual=${r.opening_manual}`);
    }
  }

  console.log("\n── committed to today's live orders (stock_deducted, not cancelled) ──");
  const committed = await pgClient`
    SELECT p.code, COUNT(DISTINCT o.id)::int AS orders, SUM(oi.quantity)::int AS qty
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      JOIN products p ON p.id = oi.product_id
     WHERE o.stock_deducted = true AND o.status <> 'cancelled'
       AND o.delivery_date = ${today}::date
       AND p.code IN ('PD0191','PD0191S')
     GROUP BY p.code ORDER BY p.code
  ` as any[];
  for (const r of committed) console.log(`  ${r.code}: ${r.qty} units across ${r.orders} orders`);

  console.log("\n── dispatch-sheet lines today (as the loading checklist groups them) ──");
  const disp = await pgClient`
    WITH dispatch_lines AS (
      SELECT COALESCE(o.route_id, d.route_id) AS route_id, oi.product_id, oi.quantity
        FROM orders o
        JOIN dealers d ON d.id = o.dealer_id
        JOIN order_items oi ON oi.order_id = o.id
       WHERE o.delivery_date = ${today}::date
         AND o.status::text = ANY(ARRAY['pending','confirmed','dispatched'])
         AND COALESCE(o.route_id, d.route_id) IS NOT NULL
      UNION ALL
      SELECT eo.route_id, eoi.product_id, eoi.quantity
        FROM employee_orders eo
        JOIN employee_order_items eoi ON eoi.employee_order_id = eo.id
       WHERE eo.delivery_date = ${today}::date
         AND eo.status::text = ANY(ARRAY['pending','confirmed','dispatched'])
      UNION ALL
      SELECT ds.route_id, dsi.product_id, dsi.quantity
        FROM direct_sales ds
        JOIN direct_sale_items dsi ON dsi.direct_sale_id = ds.id
       WHERE ds.sale_date = ${today}::date
         AND ds.customer_type IN ('cash','vip_sample','employee_subsidy')
    )
    SELECT COALESCE(r.code,'ADHOC') AS route, p.code,
           COALESCE(p.report_alias, p.name) AS label,
           SUM(dl.quantity)::int AS packets,
           COALESCE(p.packets_crate,0)::int AS pc,
           CASE WHEN COALESCE(p.packets_crate,0) > 0
                THEN FLOOR(SUM(dl.quantity)::numeric / p.packets_crate)::int ELSE 0 END AS crates,
           CASE WHEN COALESCE(p.packets_crate,0) > 0
                THEN (SUM(dl.quantity)::int % p.packets_crate)::int ELSE SUM(dl.quantity)::int END AS loose
      FROM dispatch_lines dl
      JOIN products p ON p.id = dl.product_id AND p.deleted_at IS NULL
      LEFT JOIN routes r ON r.id = dl.route_id
     WHERE p.code IN ('PD0191','PD0191S')
     GROUP BY r.code, p.code, p.report_alias, p.name, p.packets_crate
     ORDER BY r.code NULLS LAST, p.code
  ` as any[];
  for (const r of disp) {
    console.log(`  ${String(r.route).padEnd(10)} ${r.code.padEnd(8)} ${String(r.label).padEnd(22)} packets=${String(r.packets).padStart(5)}  ${r.crates}cr + ${r.loose} loose (pc=${r.pc})`);
  }
  const totBase = disp.filter(r => r.code === 'PD0191').reduce((s, r) => s + r.packets, 0);
  const totSub  = disp.filter(r => r.code === 'PD0191S').reduce((s, r) => s + r.packets, 0);
  console.log(`  TOTAL base=${totBase}  sub=${totSub}  physical pouches to load=${totBase + totSub}`);

  await pgClient.end();
}

main().catch(async (e) => { console.error(e); await pgClient.end(); process.exit(1); });
