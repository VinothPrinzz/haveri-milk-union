// Read-only: what is 97c2532d-58a9-468f-80e5-97766fe736dc, and what is its
// current stock position?
import { pgClient } from "./lib/db.js";

const ID = "97c2532d-58a9-468f-80e5-97766fe736dc";

async function main() {
  const [{ d: today }] = await pgClient`
    SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS d
  ` as any[];
  console.log("today (IST):", today, "\n");

  const asProduct = await pgClient`
    SELECT p.id::text AS id, p.code, p.name, c.name AS category,
           p.unit, p.available, p.stock AS legacy_counter,
           p.stock_source_product_id::text AS stock_source,
           p.deleted_at
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.id = ${ID}::uuid
  `;
  console.log("── as products.id ──");
  if (!asProduct.length) console.log("  no match");
  for (const r of asProduct as any[]) {
    console.log(`  ${r.code}  ${r.name}`);
    console.log(`  category=${r.category}  unit=${r.unit}  available=${r.available}  deleted=${r.deleted_at ?? "no"}`);
    console.log(`  legacy products.stock counter=${r.legacy_counter}  stock_source=${r.stock_source ?? "(self)"}`);
  }

  const asLog = await pgClient`
    SELECT f.id::text AS id, f.date::text AS date, p.code, p.name,
           f.opening, f.received, f.dispatched, f.wastage, f.closing,
           f.opening_manual
      FROM fgs_stock_log f
      JOIN products p ON p.id = f.product_id
     WHERE f.id = ${ID}::uuid
  `;
  console.log("\n── as fgs_stock_log.id ──");
  if (!asLog.length) console.log("  no match");
  for (const r of asLog as any[]) {
    console.log(`  ${r.date}  ${r.code} ${r.name}`);
    console.log(`  opening=${r.opening} received=${r.received} dispatched=${r.dispatched} wastage=${r.wastage} closing=${r.closing} manual=${r.opening_manual}`);
  }

  if (asProduct.length) {
    const rows = await pgClient`
      SELECT f.date::text AS date, f.opening, f.received, f.dispatched,
             f.wastage, f.closing, f.opening_manual
        FROM fgs_stock_log f
       WHERE f.product_id = ${ID}::uuid
       ORDER BY f.date DESC LIMIT 6
    `;
    console.log("\n── stored fgs_stock_log rows (latest 6) ──");
    for (const r of rows as any[]) {
      console.log(`  ${r.date}  o=${r.opening} r=${r.received} d=${r.dispatched} w=${r.wastage} c=${r.closing}  manual=${r.opening_manual}`);
    }

    const [live] = await pgClient`
      SELECT opening, received, dispatched, wastage, closing
        FROM fgs_day(${today}::date) WHERE product_id = ${ID}::uuid
    ` as any[];
    console.log("\n── what the app shows for TODAY ──");
    console.log(`  opening=${live?.opening} received=${live?.received} dispatched=${live?.dispatched} wastage=${live?.wastage} closing=${live?.closing}`);

    const [avail] = await pgClient`
      SELECT fgs_available(${ID}::uuid, ${today}::date) AS a
    ` as any[];
    console.log(`  order-gate availability = ${avail?.a}`);

    const [committed] = await pgClient`
      SELECT COALESCE(SUM(oi.quantity), 0)::int AS qty, count(DISTINCT o.id)::int AS orders
        FROM orders o
        JOIN order_items oi ON oi.order_id = o.id
        JOIN products pp    ON pp.id = oi.product_id
       WHERE o.stock_deducted = true AND o.status <> 'cancelled'
         AND o.delivery_date = ${today}::date
         AND COALESCE(pp.stock_source_product_id, pp.id) = ${ID}::uuid
    ` as any[];
    console.log(`  committed to today's live orders: ${committed?.qty} units across ${committed?.orders} orders`);
  }

  await pgClient.end();
}

main().catch(async (e) => { console.error(e); await pgClient.end(); process.exit(1); });
