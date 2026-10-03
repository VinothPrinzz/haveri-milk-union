// DRY RUN for migration 0063 — applies the whole file inside a transaction,
// measures the effect on every dealer-visible stock number, then ROLLS BACK.
// Nothing is persisted.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pgClient } from "./lib/db.js";

const here = dirname(fileURLToPath(import.meta.url));
const sqlPath = join(here, "../../../packages/db/src/migrations/0063_fgs_carry_forward_opening.sql");

class Rollback extends Error {}

async function main() {
  // The availability formula as it stands BEFORE this migration.
  const before = new Map(
    ((await pgClient`
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
    `) as any[]).map(r => [r.id, r])
  );
  console.log(`pre-migration availability captured for ${before.size} products\n`);

  // Strip the file's own BEGIN/COMMIT — we supply the transaction so we can
  // roll it back.
  const body = readFileSync(sqlPath, "utf8")
    .replace(/^\s*BEGIN\s*;\s*$/gim, "")
    .replace(/^\s*COMMIT\s*;\s*$/gim, "");

  try {
    await pgClient.begin(async (_tx) => {
      const tx = _tx as unknown as typeof pgClient;
      await tx.unsafe(body);
      console.log("migration SQL executed cleanly (syntax + baseline insert OK)");

      const after = (await tx`
        SELECT p.id::text AS id, p.code, p.name,
               GREATEST(COALESCE(fd.closing, 0), 0)::int AS stock
          FROM products p
          LEFT JOIN fgs_day((now() AT TIME ZONE 'Asia/Kolkata')::date) fd
                 ON fd.product_id = p.id
         WHERE p.deleted_at IS NULL AND p.available = true
           AND p.code IS DISTINCT FROM 'PD0191S'
      `) as any[];

      let same = 0;
      const moved: any[] = [];
      for (const a of after) {
        const b = before.get(a.id);
        if (!b) continue;
        if (Number(b.stock) === Number(a.stock)) same++;
        else moved.push({ code: a.code, name: a.name, before: Number(b.stock), after: Number(a.stock) });
      }
      console.log(`\nTODAY's dealer-visible stock — unchanged: ${same}   changed: ${moved.length}`);
      moved.sort((x, y) => Math.abs(y.after - y.before) - Math.abs(x.after - x.before));
      for (const m of moved.slice(0, 25)) {
        const d = m.after - m.before;
        console.log(`  ${String(m.code).padEnd(9)} ${String(m.before).padStart(7)} → ${String(m.after).padStart(7)}  (${d > 0 ? "+" : ""}${d})  ${m.name}`);
      }
      const wentZero = moved.filter(m => m.before > 0 && m.after === 0);
      console.log(`\nnewly OUT OF STOCK today: ${wentZero.length}`);
      for (const m of wentZero) console.log(`  ${m.code} ${m.name} (was ${m.before})`);

      // What tomorrow opens at, i.e. today's closing carried forward.
      const tomorrow = (await tx`
        SELECT p.code, p.name, fd.opening, fd.received, fd.dispatched, fd.wastage, fd.closing
          FROM products p
          JOIN fgs_day(((now() AT TIME ZONE 'Asia/Kolkata')::date + 1)) fd
            ON fd.product_id = p.id
         WHERE p.deleted_at IS NULL AND p.available = true
         ORDER BY fd.opening DESC
         LIMIT 12
      `) as any[];
      console.log("\nTOMORROW's opening (= today's closing), top 12 by volume:");
      for (const r of tomorrow) {
        console.log(`  ${String(r.code).padEnd(9)} opening=${String(r.opening).padStart(7)}  ${r.name}`);
      }

      const [{ n }] = (await tx`
        SELECT count(*)::int AS n FROM fgs_stock_log
         WHERE date = (now() AT TIME ZONE 'Asia/Kolkata')::date AND opening_manual
      `) as any[];
      console.log(`\nbaseline rows that would be flagged for today: ${n}`);

      throw new Rollback();
    });
  } catch (e) {
    if (e instanceof Rollback) console.log("\n── rolled back, nothing persisted ──");
    else throw e;
  }

  await pgClient.end();
}

main().catch(async (e) => { console.error(e); await pgClient.end(); process.exit(1); });
