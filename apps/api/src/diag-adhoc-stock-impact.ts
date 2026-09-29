// READ ONLY. How much stock is currently leaking out of the FGS model?
//
// fgs_day()'s `committed` CTE reads ONLY the `orders` table. Two other rails
// physically remove goods from FGS and are invisible to it:
//   1. direct_sales  — counter sales, VIP samples, agent gate passes
//   2. employee_orders — the employee subsidy indent rail
//
// This measures both, and — critically — checks whether folding them into the
// model retroactively would drive availability negative and start REFUSING
// orders (the exact catastrophe migration 0063's cutover baseline avoided).
//
// USAGE (from apps/api):  npx tsx src/diag-adhoc-stock-impact.ts
import { pgClient } from "./lib/db.js";

const [{ today, cutover }] = (await pgClient`
  SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS today,
         (SELECT MIN(f.date)::text FROM fgs_stock_log f WHERE f.opening_manual) AS cutover
`) as any[];
console.log(`IST today ${today}   carry-forward cutover ${cutover}\n`);

// ── 1. Volume on each invisible rail ────────────────────────────────
const ds = (await pgClient`
  SELECT d.customer_type::text AS kind,
         count(DISTINCT d.id)::int AS sales,
         SUM(di.quantity)::int     AS units,
         MIN(d.sale_date)::text    AS first_date,
         MAX(d.sale_date)::text    AS last_date
    FROM direct_sales d
    JOIN direct_sale_items di ON di.direct_sale_id = d.id
   WHERE d.status = 'confirmed'
   GROUP BY 1 ORDER BY 3 DESC
`) as any[];
console.log("── direct_sales (confirmed), all time ──");
for (const r of ds)
  console.log(
    `  ${r.kind.padEnd(16)} sales=${String(r.sales).padStart(4)} units=${String(r.units).padStart(7)}` +
      `   ${r.first_date} .. ${r.last_date}`,
  );

const [gp] = (await pgClient`
  SELECT COALESCE(SUM(gpi.returned_quantity), 0)::int AS returned
    FROM gate_pass_items gpi
    JOIN direct_sales d ON d.id = gpi.direct_sale_id
   WHERE d.status = 'confirmed'
`) as any[];
console.log(`  gate-pass units returned (must NOT be deducted): ${gp.returned}`);

const eo = (await pgClient`
  SELECT e.status::text AS status,
         count(DISTINCT e.id)::int   AS orders,
         SUM(ei.quantity)::int       AS units,
         MIN(e.delivery_date)::text  AS first_date,
         MAX(e.delivery_date)::text  AS last_date
    FROM employee_orders e
    JOIN employee_order_items ei ON ei.employee_order_id = e.id
   GROUP BY 1 ORDER BY 3 DESC
`) as any[];
console.log("\n── employee_orders, all time ──");
for (const r of eo)
  console.log(
    `  ${r.status.padEnd(16)} orders=${String(r.orders).padStart(4)} units=${String(r.units).padStart(7)}` +
      `   ${r.first_date} .. ${r.last_date}`,
  );

// ── 2. Post-cutover volume — the part that would actually change ────
const dsPost = (await pgClient`
  SELECT d.sale_date::text AS d, SUM(di.quantity)::int AS units
    FROM direct_sales d
    JOIN direct_sale_items di ON di.direct_sale_id = d.id
   WHERE d.status = 'confirmed' AND d.sale_date >= ${cutover}::date
   GROUP BY 1 ORDER BY 1
`) as any[];
console.log(`\n── direct-sale units per day since cutover (${cutover}) ──`);
for (const r of dsPost) console.log(`  ${r.d}  ${r.units}`);

// ── 3. THE SAFETY QUESTION ──────────────────────────────────────────
// For every product, what would TODAY's availability become if confirmed
// direct sales dated today were folded in? Anything that goes negative would
// start refusing dealer orders the moment the migration lands.
const impact = (await pgClient`
  WITH ds_today AS (
    SELECT COALESCE(pp.stock_source_product_id, pp.id) AS product_id,
           SUM(di.quantity - COALESCE(gpi.returned_quantity, 0))::int AS units
      FROM direct_sales d
      JOIN direct_sale_items di ON di.direct_sale_id = d.id
      JOIN products pp          ON pp.id = di.product_id
      LEFT JOIN gate_pass_items gpi
             ON gpi.direct_sale_id = d.id AND gpi.product_id = di.product_id
     WHERE d.status = 'confirmed' AND d.sale_date = ${today}::date
     GROUP BY 1
  )
  SELECT p.code, p.name,
         fgs_available(p.id, ${today}::date) AS current_avail,
         t.units,
         (fgs_available(p.id, ${today}::date) - t.units) AS would_be
    FROM ds_today t
    JOIN products p ON p.id = t.product_id
   ORDER BY (fgs_available(p.id, ${today}::date) - t.units) ASC
`) as any[];

console.log(`\n── if today's direct sales were folded into availability ──`);
if (impact.length === 0) console.log("  (no confirmed direct sales dated today)");
for (const r of impact)
  console.log(
    `  ${String(r.code).padEnd(8)} ${String(r.name).slice(0, 26).padEnd(28)} ` +
      `now=${String(r.current_avail).padStart(6)}  adhoc=${String(r.units).padStart(4)}  ` +
      `would be=${String(r.would_be).padStart(6)}${Number(r.would_be) < 0 ? "   <-- NEGATIVE" : ""}`,
  );

const neg = impact.filter((r: any) => Number(r.would_be) < 0);
console.log(
  `\n  ${neg.length} of ${impact.length} products would go negative today.`,
);

// ── 4. Same question across the whole post-cutover window ───────────
// A negative on a PAST day matters less (nobody orders into the past), but a
// deeply negative carry-forward poisons every day after it.
const days = (await pgClient`
  SELECT generate_series(${cutover}::date, ${today}::date, '1 day')::date::text AS d
`) as any[];
console.log("\n── worst product per day, if direct sales were counted ──");
for (const { d } of days) {
  const [w] = (await pgClient`
    WITH ds_day AS (
      SELECT COALESCE(pp.stock_source_product_id, pp.id) AS product_id,
             SUM(di.quantity - COALESCE(gpi.returned_quantity, 0))::int AS units
        FROM direct_sales ds
        JOIN direct_sale_items di ON di.direct_sale_id = ds.id
        JOIN products pp          ON pp.id = di.product_id
        LEFT JOIN gate_pass_items gpi
               ON gpi.direct_sale_id = ds.id AND gpi.product_id = di.product_id
       WHERE ds.status = 'confirmed' AND ds.sale_date = ${d}::date
       GROUP BY 1
    )
    SELECT p.code, (fd.closing - t.units) AS would_be, fd.closing, t.units
      FROM ds_day t
      JOIN products p ON p.id = t.product_id
      JOIN fgs_day(${d}::date) fd ON fd.product_id = t.product_id
     ORDER BY 2 ASC LIMIT 1
  `) as any[];
  console.log(
    w
      ? `  ${d}  worst ${String(w.code).padEnd(8)} closing=${String(w.closing).padStart(6)} - adhoc=${String(w.units).padStart(4)} = ${String(w.would_be).padStart(6)}`
      : `  ${d}  (no direct sales)`,
  );
}

await pgClient.end();
