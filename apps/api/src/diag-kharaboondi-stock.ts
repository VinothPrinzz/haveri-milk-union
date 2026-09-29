// READ ONLY. What is KHARABOONDI 180GM's stock situation right now, and what
// adhoc (direct) sales exist for it that never touched the FGS sheet?
//
// USAGE (from apps/api):  npx tsx src/diag-kharaboondi-stock.ts
import { pgClient } from "./lib/db.js";

const [{ today }] = (await pgClient`
  SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS today
`) as any[];
console.log(`IST today: ${today}\n`);

const prods = (await pgClient`
  SELECT p.id, p.code, p.name, p.stock::numeric AS counter,
         p.stock_source_product_id, p.deleted_at
    FROM products p
   WHERE p.name ILIKE '%KHARA%BOONDI%' OR p.name ILIKE '%KHARA%BUNDI%'
   ORDER BY p.name
`) as any[];

console.log("── matching products ──");
for (const p of prods)
  console.log(
    `  ${p.code}  ${p.name.padEnd(28)} counter=${p.counter}` +
      `${p.stock_source_product_id ? "  (variant of " + p.stock_source_product_id + ")" : ""}` +
      `${p.deleted_at ? "  DELETED" : ""}  id=${p.id}`,
  );

for (const p of prods) {
  if (p.deleted_at) continue;
  const stockId = p.stock_source_product_id ?? p.id;

  const [avail] = (await pgClient`
    SELECT fgs_available(${stockId}::uuid, ${today}::date) AS n
  `) as any[];

  const day = (await pgClient`
    SELECT opening, received, dispatched, wastage, closing
      FROM fgs_day(${today}::date)
     WHERE product_id = ${stockId}::uuid
  `) as any[];

  const rows = (await pgClient`
    SELECT date::text AS d, opening, received, dispatched, wastage, closing,
           opening_manual
      FROM fgs_stock_log
     WHERE product_id = ${stockId}::uuid
     ORDER BY date DESC
     LIMIT 8
  `) as any[];

  console.log(`\n══ ${p.code} ${p.name} ══`);
  console.log(`  fgs_available(today) = ${avail.n}`);
  if (day[0])
    console.log(
      `  fgs_day(today): opening=${day[0].opening} received=${day[0].received} ` +
        `dispatched=${day[0].dispatched} wastage=${day[0].wastage} closing=${day[0].closing}`,
    );
  console.log("  ── stored fgs_stock_log rows (latest 8) ──");
  for (const r of rows)
    console.log(
      `    ${r.d}  op=${String(r.opening).padStart(5)} rec=${String(r.received).padStart(5)} ` +
        `disp=${String(r.dispatched).padStart(5)} wast=${String(r.wastage).padStart(4)} ` +
        `close=${String(r.closing).padStart(5)}${r.opening_manual ? "  [manual]" : ""}`,
    );

  // Live orders holding stock for today
  const orders = (await pgClient`
    SELECT left(o.id::text, 8) AS order_no, o.status, o.delivery_date::text AS dd,
           o.stock_deducted, oi.quantity
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      JOIN products pp    ON pp.id = oi.product_id
     WHERE COALESCE(pp.stock_source_product_id, pp.id) = ${stockId}::uuid
       AND o.delivery_date >= ${today}::date - 7
     ORDER BY o.delivery_date DESC
     LIMIT 20
  `) as any[];
  console.log(`  ── orders (last 7 days), ${orders.length} rows ──`);
  for (const o of orders)
    console.log(
      `    ${o.dd}  ${String(o.order_no).padEnd(12)} ${o.status.padEnd(10)} ` +
        `qty=${o.quantity} deducted=${o.stock_deducted}`,
    );

  // Adhoc / direct sales — the rail that never touches FGS
  const ds = (await pgClient`
    SELECT d.gp_no, d.sale_date::text AS sd, d.status, d.customer_type::text AS ct,
           d.dispatched_at, di.quantity, d.recipient_name AS customer_name
      FROM direct_sales d
      JOIN direct_sale_items di ON di.direct_sale_id = d.id
      JOIN products pp          ON pp.id = di.product_id
     WHERE COALESCE(pp.stock_source_product_id, pp.id) = ${stockId}::uuid
     ORDER BY d.sale_date DESC
     LIMIT 20
  `) as any[];
  console.log(`  ── direct/adhoc sales, ${ds.length} rows ──`);
  for (const s of ds)
    console.log(
      `    ${s.sd}  ${String(s.gp_no).padEnd(12)} ${s.status.padEnd(10)} ${s.ct.padEnd(14)} ` +
        `qty=${s.quantity} dispatched_at=${s.dispatched_at ?? "NULL"}  ${s.customer_name ?? ""}`,
    );
}

await pgClient.end();
