// DRY RUN for migration 0064 — applies it in a transaction, checks that every
// PAST date renders exactly what the pre-0063 read path rendered and that
// today is untouched, then ROLLS BACK.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pgClient } from "./lib/db.js";

const here = dirname(fileURLToPath(import.meta.url));
const sqlPath = join(here, "../../../packages/db/src/migrations/0064_fgs_freeze_pre_cutover_history.sql");

class Rollback extends Error {}

// The pre-0063 read path, verbatim from the old inventory.ts GET /fgs/overview.
const legacySql = (tx: typeof pgClient, date: string) => tx`
  WITH dispatched_qty AS (
    SELECT oi.product_id, SUM(oi.quantity)::int AS qty
    FROM orders o
    JOIN order_items oi ON oi.order_id = o.id
    WHERE o.delivery_date = ${date}::date
      AND o.status IN ('dispatched', 'delivered')
    GROUP BY oi.product_id
  )
  SELECT p.id::text AS product_id,
         COALESCE(
           fsl.opening,
           (SELECT prev.closing FROM fgs_stock_log prev
             WHERE prev.product_id = p.id AND prev.date < ${date}::date
             ORDER BY prev.date DESC LIMIT 1),
           0)::int                    AS opening,
         COALESCE(fsl.received, 0)::int AS received,
         COALESCE(dq.qty, 0)::int       AS dispatched,
         COALESCE(fsl.wastage, 0)::int  AS wastage
  FROM products p
  LEFT JOIN fgs_stock_log fsl ON fsl.product_id = p.id AND fsl.date = ${date}::date
  LEFT JOIN dispatched_qty dq ON dq.product_id = p.id
  WHERE p.deleted_at IS NULL
`;

async function main() {
  const [{ d: today }] = await pgClient`
    SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS d
  ` as any[];

  // Today's dealer-visible stock BEFORE 0064 — must not move.
  const beforeToday = new Map(
    ((await pgClient`
      SELECT p.id::text AS id, p.code,
             GREATEST(COALESCE(fd.closing, 0), 0)::int AS stock
        FROM products p
        LEFT JOIN fgs_day(${today}::date) fd ON fd.product_id = p.id
       WHERE p.deleted_at IS NULL AND p.available = true
    `) as any[]).map(r => [r.id, r])
  );

  const body = readFileSync(sqlPath, "utf8")
    .replace(/^\s*BEGIN\s*;\s*$/gim, "")
    .replace(/^\s*COMMIT\s*;\s*$/gim, "");

  try {
    await pgClient.begin(async (_tx) => {
      const tx = _tx as unknown as typeof pgClient;
      await tx.unsafe(body);
      console.log("migration 0064 executed cleanly\n");

      const [{ c: cutover }] = await tx`
        SELECT COALESCE(MIN(date), '-infinity'::date)::text AS c
          FROM fgs_stock_log WHERE opening_manual
      ` as any[];
      console.log("discovered cutover:", cutover, "\n");

      // Past dates must match the pre-0063 formula exactly.
      console.log("── PAST dates: fgs_day vs the pre-0063 read path ──");
      for (let back = 1; back <= 10; back++) {
        const [{ d }] = await tx`
          SELECT ((now() AT TIME ZONE 'Asia/Kolkata')::date - ${back}::int)::text AS d
        ` as any[];
        const legacy = new Map(
          ((await legacySql(tx, d)) as any[]).map(r => [r.product_id, r])
        );
        const now = (await tx`
          SELECT product_id::text AS product_id, opening, received, dispatched, wastage, closing
            FROM fgs_day(${d}::date)
        `) as any[];
        let diff = 0;
        for (const n of now) {
          const l = legacy.get(n.product_id);
          if (!l) { diff++; continue; }
          const lClosing = Number(l.opening) + Number(l.received) - Number(l.dispatched) - Number(l.wastage);
          if (Number(n.opening) !== Number(l.opening) ||
              Number(n.received) !== Number(l.received) ||
              Number(n.dispatched) !== Number(l.dispatched) ||
              Number(n.wastage) !== Number(l.wastage) ||
              Number(n.closing) !== lClosing) diff++;
        }
        const sums = now.reduce((a: any, r: any) => ({
          o: a.o + Number(r.opening), c: a.c + Number(r.closing),
        }), { o: 0, c: 0 });
        console.log(`  ${d}  rows=${now.length}  differing from pre-0063: ${diff}   totals open/close = ${sums.o}/${sums.c}`);
      }

      // Today must be unchanged by 0064.
      const afterToday = (await tx`
        SELECT p.id::text AS id, p.code,
               GREATEST(COALESCE(fd.closing, 0), 0)::int AS stock
          FROM products p
          LEFT JOIN fgs_day(${today}::date) fd ON fd.product_id = p.id
         WHERE p.deleted_at IS NULL AND p.available = true
      `) as any[];
      const movedToday = afterToday.filter(
        a => Number(beforeToday.get(a.id)?.stock) !== Number(a.stock)
      );
      console.log(`\nTODAY (${today}) dealer-visible stock changed by 0064: ${movedToday.length} of ${afterToday.length}`);
      for (const m of movedToday.slice(0, 10)) {
        console.log(`  ${m.code}: ${beforeToday.get(m.id)?.stock} → ${m.stock}`);
      }

      // And tomorrow still carries today's closing.
      const tomorrow = (await tx`
        SELECT p.code, fd.opening
          FROM products p
          JOIN fgs_day(((now() AT TIME ZONE 'Asia/Kolkata')::date + 1)) fd ON fd.product_id = p.id
         WHERE p.deleted_at IS NULL AND p.available = true
         ORDER BY fd.opening DESC LIMIT 5
      `) as any[];
      console.log("\ntomorrow's opening still carries forward, top 5:");
      for (const r of tomorrow) console.log(`  ${String(r.code).padEnd(9)} ${r.opening}`);

      throw new Rollback();
    });
  } catch (e) {
    if (e instanceof Rollback) console.log("\n── rolled back, nothing persisted ──");
    else throw e;
  }

  await pgClient.end();
}

main().catch(async (e) => { console.error(e); await pgClient.end(); process.exit(1); });
