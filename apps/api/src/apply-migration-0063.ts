// Applies packages/db/src/migrations/0063_fgs_carry_forward_opening.sql.
//
// The repo's _migrations table is stale, so the runner must never be pointed at
// prod — this executes the one file directly. The SQL is idempotent (ADD COLUMN
// IF NOT EXISTS / DROP ... IF EXISTS + CREATE / ON CONFLICT DO UPDATE), so a
// re-run is safe, but note the baseline INSERT snapshots whatever "today" is
// when it runs, and only for products that have no baseline row yet.
//
// The file's own BEGIN/COMMIT are stripped: postgres.js refuses a bare BEGIN
// inside sql.unsafe on a pooled connection (UNSAFE_TRANSACTION) — the server
// still runs the batch, but the driver aborts before the script can report.
// Supplying the transaction via sql.begin keeps it atomic AND observable.
//
// Prints a before/after comparison of the number every dealer sees, so a
// regression is obvious rather than silent.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pgClient } from "./lib/db.js";

const here = dirname(fileURLToPath(import.meta.url));
const sqlPath = join(here, "../../../packages/db/src/migrations/0063_fgs_carry_forward_opening.sql");

// The availability formula as it stands BEFORE this migration.
async function snapshotBefore() {
  return await pgClient`
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
    )
    SELECT p.id::text AS id, p.code, p.name,
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
  `;
}

async function snapshotAfter() {
  return await pgClient`
    SELECT p.id::text AS id, p.code, p.name,
           GREATEST(COALESCE(fd.closing, 0), 0)::int AS stock
      FROM products p
      LEFT JOIN fgs_day((now() AT TIME ZONE 'Asia/Kolkata')::date) fd
             ON fd.product_id = p.id
     WHERE p.deleted_at IS NULL AND p.available = true
       AND p.code IS DISTINCT FROM 'PD0191S'
  `;
}

async function main() {
  const before = new Map(
    (await snapshotBefore() as any[]).map(r => [r.id, r])
  );
  console.log(`captured pre-migration availability for ${before.size} products`);

  const body = readFileSync(sqlPath, "utf8")
    .replace(/^\s*BEGIN\s*;\s*$/gim, "")
    .replace(/^\s*COMMIT\s*;\s*$/gim, "");
  await pgClient.begin(async (_tx) => {
    const tx = _tx as unknown as typeof pgClient;
    await tx.unsafe(body);
  });
  console.log("migration 0063 applied");

  const after = await snapshotAfter() as any[];
  let same = 0;
  const moved: any[] = [];
  for (const a of after) {
    const b = before.get(a.id);
    if (!b) continue;
    if (Number(b.stock) === Number(a.stock)) same++;
    else moved.push({ code: a.code, name: a.name, before: Number(b.stock), after: Number(a.stock) });
  }
  console.log(`\nunchanged: ${same}   changed: ${moved.length}`);
  moved.sort((x, y) => Math.abs(y.after - y.before) - Math.abs(x.after - x.before));
  for (const m of moved.slice(0, 30)) {
    const delta = m.after - m.before;
    console.log(`  ${String(m.code).padEnd(9)} ${String(m.before).padStart(7)} → ${String(m.after).padStart(7)}  (${delta > 0 ? "+" : ""}${delta})  ${m.name}`);
  }

  const wentZero = moved.filter(m => m.before > 0 && m.after === 0);
  console.log(`\nproducts that would newly show OUT OF STOCK: ${wentZero.length}`);
  for (const m of wentZero) console.log(`  ${m.code} ${m.name} (was ${m.before})`);

  const [{ n }] = await pgClient`
    SELECT count(*)::int AS n FROM fgs_stock_log
     WHERE date = (now() AT TIME ZONE 'Asia/Kolkata')::date AND opening_manual
  ` as any[];
  console.log(`\nbaseline rows flagged for today: ${n}`);

  await pgClient.end();
}

main().catch(async (e) => { console.error(e); await pgClient.end(); process.exit(1); });
