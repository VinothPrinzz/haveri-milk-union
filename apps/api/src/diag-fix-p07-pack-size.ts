// P07 "G/L UHT GOLD 1000ML 12 PACK" is a 12 x 1000ML case (base_price 807.24,
// vs 785.52 for the 12.00 L PD0183) but its pack_size was stored as 1.00 L, so
// every report that converts packets to litres counted one case as 1 L.
// Sets pack_size = 12.00. Read-back + past-sales impact printed either side.
import { pgClient } from "./lib/db.js";

const APPLY = process.argv.includes("--apply");

async function show(label: string) {
  const [p] = (await pgClient`
    SELECT p.code, p.name, p.pack_size, p.unit, p.base_price, c.name AS category
    FROM products p LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.code = 'P07'
  `) as any[];
  console.log(`${label}: ${p.code} "${String(p.name).trim()}" pack_size=${p.pack_size} unit=${p.unit} base_price=${p.base_price} category=${p.category}`);
  return p;
}

async function main() {
  const sales = await pgClient`
    WITH combined AS (
      SELECT o.delivery_date AS d, oi.quantity::int AS qty
      FROM orders o JOIN order_items oi ON oi.order_id = o.id
      JOIN products p ON p.id = oi.product_id
      WHERE p.code = 'P07' AND o.status IN ('confirmed','dispatched','delivered')
      UNION ALL
      SELECT ds.sale_date, dsi.quantity::int
      FROM direct_sales ds JOIN direct_sale_items dsi ON dsi.direct_sale_id = ds.id
      JOIN products p ON p.id = dsi.product_id
      WHERE p.code = 'P07' AND ds.status = 'confirmed'
      UNION ALL
      SELECT eo.delivery_date, eoi.quantity::int
      FROM employee_orders eo JOIN employee_order_items eoi ON eoi.employee_order_id = eo.id
      JOIN products p ON p.id = eoi.product_id
      WHERE p.code = 'P07' AND eo.status IN ('confirmed','dispatched','delivered')
    )
    SELECT COUNT(*)::int AS lines, COALESCE(SUM(qty),0)::int AS packets,
           MIN(d)::text AS first_sale, MAX(d)::text AS last_sale
    FROM combined
  `;
  const s = (sales as any[])[0];
  console.log(`P07 sales to date: ${s.lines} line(s), ${s.packets} packet(s), ${s.first_sale ?? "-"} .. ${s.last_sale ?? "-"}`);
  console.log(`  litre impact of the fix on history: ${s.packets} x (12.00 - 1.00) = ${s.packets * 11} L\n`);

  await show("before");
  if (!APPLY) { console.log("\n(dry run - pass --apply to write)"); await pgClient.end(); return; }

  const updated = await pgClient`
    UPDATE products SET pack_size = 12.00, updated_at = now()
    WHERE code = 'P07' AND pack_size = 1.00 AND deleted_at IS NULL
    RETURNING id
  `;
  console.log(`rows updated: ${updated.length}`);
  await show("after ");
  await pgClient.end();
}
main().catch(e => { console.error(e); process.exit(1); });
