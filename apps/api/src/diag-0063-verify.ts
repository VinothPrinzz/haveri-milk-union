// Read-only: confirm migration 0063 landed correctly.
//
//  1. Does the new dealer-visible stock match what the OLD formula reported?
//     (It must — the baseline was snapshotted from the old formula.)
//  2. Do the stored dispatched/closing columns agree with fgs_day?
//  3. What does tomorrow open at?
import { pgClient } from "./lib/db.js";

async function main() {
  const rows = await pgClient`
    WITH today AS (SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date AS d),
    reserved AS (
      SELECT COALESCE(pp.stock_source_product_id, pp.id) AS stock_product_id,
             SUM(oi.quantity)::int AS qty
        FROM orders o
        JOIN order_items oi ON oi.order_id = o.id
        JOIN products pp    ON pp.id = oi.product_id
       WHERE o.delivery_date = (SELECT d FROM today)
         AND o.stock_deducted = true
       GROUP BY 1
    ),
    old AS (
      SELECT p.id,
             GREATEST(
               COALESCE(
                 fsl.opening,
                 (SELECT prev.closing FROM fgs_stock_log prev
                   WHERE prev.product_id = p.id AND prev.date < (SELECT d FROM today)
                   ORDER BY prev.date DESC LIMIT 1),
                 0)
               + COALESCE(fsl.received, 0)
               - COALESCE(fsl.wastage, 0)
               - COALESCE(r.qty, 0), 0)::int AS stock
        FROM products p
        LEFT JOIN fgs_stock_log fsl ON fsl.product_id = p.id AND fsl.date = (SELECT d FROM today)
        LEFT JOIN reserved r        ON r.stock_product_id = p.id
       WHERE p.deleted_at IS NULL AND p.available = true
         AND p.code IS DISTINCT FROM 'PD0191S'
    )
    SELECT p.code, p.name, o.stock AS old_stock,
           GREATEST(COALESCE(fd.closing, 0), 0)::int AS new_stock,
           fgs_available(p.id, (SELECT d FROM today))  AS gate_stock
      FROM products p
      JOIN old o ON o.id = p.id
      LEFT JOIN fgs_day((SELECT d FROM today)) fd ON fd.product_id = p.id
     ORDER BY o.stock DESC
  `;

  const diffs = (rows as any[]).filter(r => Number(r.old_stock) !== Number(r.new_stock));
  const gateDiffs = (rows as any[]).filter(
    r => Number(r.new_stock) !== Math.max(0, Number(r.gate_stock))
  );
  console.log(`products checked: ${rows.length}`);
  console.log(`old formula vs new: ${diffs.length} differ`);
  for (const d of diffs.slice(0, 20)) {
    console.log(`  ${String(d.code).padEnd(9)} ${d.old_stock} → ${d.new_stock}  ${d.name}`);
  }
  console.log(`dealer list vs order gate: ${gateDiffs.length} differ`);
  for (const d of gateDiffs.slice(0, 20)) {
    console.log(`  ${String(d.code).padEnd(9)} list=${d.new_stock} gate=${d.gate_stock}  ${d.name}`);
  }

  // Stored columns vs derived.
  const drift = await pgClient`
    SELECT count(*)::int AS n
      FROM fgs_stock_log f
      JOIN fgs_day((now() AT TIME ZONE 'Asia/Kolkata')::date) d ON d.product_id = f.product_id
     WHERE f.date = (now() AT TIME ZONE 'Asia/Kolkata')::date
       AND (f.opening, f.dispatched, f.closing) IS DISTINCT FROM (d.opening, d.dispatched, d.closing)
  `;
  console.log(`\nstored rows out of step with fgs_day: ${(drift[0] as any).n}`);

  const tomorrow = await pgClient`
    SELECT p.code, p.name, fd.opening
      FROM products p
      JOIN fgs_day(((now() AT TIME ZONE 'Asia/Kolkata')::date + 1)) fd ON fd.product_id = p.id
     WHERE p.deleted_at IS NULL AND p.available = true
     ORDER BY fd.opening DESC LIMIT 10
  `;
  console.log("\ntomorrow's opening (= today's closing), top 10:");
  for (const r of tomorrow as any[]) {
    console.log(`  ${String(r.code).padEnd(9)} ${String(r.opening).padStart(7)}  ${r.name}`);
  }

  await pgClient.end();
}

main().catch(async (e) => { console.error(e); await pgClient.end(); process.exit(1); });
