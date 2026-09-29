// Applies migration 0072 (direct sales feed the FGS stock model) over the
// DIRECT connection (:5432) as ONE transaction, and verifies INSIDE the
// transaction that the new model behaves before deciding to keep it.
//
// The file is executed as a single block rather than split on ";" — the two
// function bodies are $$-quoted and a naive splitter would tear them apart.
//
// USAGE (from apps/api):
//   npx tsx src/diag-apply-0072.ts            <- dry run (prints, rolls back)
//   npx tsx src/diag-apply-0072.ts --apply    <- commit
import postgres from "postgres";
import { readFileSync } from "node:fs";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

const APPLY = process.argv.includes("--apply");

const direct = process.env.DATABASE_URL;
if (!direct) throw new Error("DATABASE_URL (direct, :5432) not set");
const sql = postgres(direct, { prepare: false, max: 1, connect_timeout: 15 });

/** Availability for every product touched by either newly-counted rail. */
async function snapshot(client: any, today: string) {
  return (await client.unsafe(`
    SELECT p.code,
           p.name,
           fgs_available(p.id, DATE '${today}') AS avail
      FROM products p
     WHERE p.deleted_at IS NULL
       AND (EXISTS (
             SELECT 1 FROM direct_sale_items di
              JOIN products pp ON pp.id = di.product_id
             WHERE COALESCE(pp.stock_source_product_id, pp.id) = p.id)
        OR EXISTS (
             SELECT 1 FROM employee_order_items ei
              JOIN products pp ON pp.id = ei.product_id
             WHERE COALESCE(pp.stock_source_product_id, pp.id) = p.id))
     ORDER BY p.code
  `)) as any[];
}

async function main() {
  console.log(APPLY ? "MIGRATION 0072 — APPLY" : "MIGRATION 0072 — DRY RUN (rolls back)");
  console.log("──────────────────────────────────────────────");

  const [{ today, cutover }] = (await sql`
    SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS today,
           (SELECT MIN(f.date)::text FROM fgs_stock_log f WHERE f.opening_manual) AS cutover
  `) as any[];
  console.log(`IST today ${today}   cutover ${cutover}\n`);

  // Every stored opening, so the migration can be held to the rule that a
  // stock correction goes in DISPATCHED and never in OPENING.
  const openingsBefore = (await sql`
    SELECT p.code, f.date::text AS d, f.opening
      FROM fgs_stock_log f JOIN products p ON p.id = f.product_id
     ORDER BY p.code, f.date
  `) as any[];
  const openingKey = (r: any) => `${r.code}|${r.d}`;
  const openingBeforeMap = new Map(openingsBefore.map((r) => [openingKey(r), Number(r.opening)]));

  const before = await snapshot(sql, today);
  console.log("availability BEFORE (products with direct-sale history):");
  for (const r of before)
    console.log(`  ${r.code.padEnd(8)} ${String(r.name).slice(0, 26).padEnd(28)} ${String(r.avail).padStart(6)}`);

  // Guard: the migration must not move the discovered cutover, or pre-cutover
  // history silently unfreezes.
  const file = readFileSync(
    path.resolve(__dirname, "../../../packages/db/src/migrations/0072_fgs_count_all_outflow_rails.sql"),
    "utf8",
  );
  const body = file.replace(/^\s*BEGIN;\s*$/m, "").replace(/^\s*COMMIT;\s*$/m, "");

  const t0 = Date.now();
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL lock_timeout = '30s'");
      await tx.unsafe("SET LOCAL statement_timeout = '5min'");

      await tx.unsafe(body);
      console.log(`\n  migration body ran in ${Date.now() - t0}ms`);

      // ── in-tx verification ──
      const [{ c: newCutover }] = (await tx.unsafe(
        `SELECT MIN(date)::text AS c FROM fgs_stock_log WHERE opening_manual`,
      )) as any[];
      console.log(`  cutover after: ${newCutover}`);
      if (newCutover !== cutover)
        throw new Error(`cutover MOVED ${cutover} -> ${newCutover} — would unfreeze history`);

      const [{ n: stillManual }] = (await tx.unsafe(
        `SELECT count(*)::int AS n FROM fgs_stock_log f JOIN products p ON p.id = f.product_id
          WHERE p.code = 'PD0205' AND f.date = DATE '2026-08-06' AND f.opening_manual`,
      )) as any[];
      console.log(`  PD0205 2026-08-06 hand patch cleared: ${stillManual === 0 ? "yes" : "NO"}`);
      if (stillManual !== 0) throw new Error("PD0205 re-baseline was not reverted — sample would double-count");

      const after = await snapshot(tx, today);
      const byCode = new Map(after.map((r: any) => [r.code, Number(r.avail)]));
      console.log("\n  availability AFTER:");
      for (const r of before) {
        const now = byCode.get(r.code)!;
        const delta = now - Number(r.avail);
        console.log(
          `    ${r.code.padEnd(8)} ${String(r.name).slice(0, 26).padEnd(28)} ` +
            `${String(r.avail).padStart(6)} -> ${String(now).padStart(6)}` +
            `${delta !== 0 ? `  (${delta > 0 ? "+" : ""}${delta})` : ""}` +
            `${now < 0 ? "   <-- NEGATIVE" : ""}`,
        );
      }

      // ── OPENING IS OFF LIMITS ──
      // Corrections belong in dispatched. The only opening this migration may
      // write is PD0205 / 2026-08-06, and only to put back the 6 it held before
      // yesterday's hand patch. Anything else moving means the carry-forward
      // chain is being rewritten instead of extended.
      const openingsAfter = (await tx.unsafe(`
        SELECT p.code, f.date::text AS d, f.opening
          FROM fgs_stock_log f JOIN products p ON p.id = f.product_id
         ORDER BY p.code, f.date
      `)) as any[];
      const moved = openingsAfter
        .map((r: any) => ({
          key: `${r.code}|${r.d}`,
          from: openingBeforeMap.get(`${r.code}|${r.d}`),
          to: Number(r.opening),
        }))
        .filter((r) => r.from !== undefined && r.from !== r.to);

      console.log(`\n  stored openings changed: ${moved.length}`);
      for (const m of moved) console.log(`    ${m.key}  ${m.from} -> ${m.to}`);

      const illegal = moved.filter(
        (m) => m.key !== "PD0205|2026-08-06" || m.to !== 6,
      );
      if (illegal.length > 0)
        throw new Error(
          "opening was rewritten where it must not be: " +
            illegal.map((m) => `${m.key} ${m.from}->${m.to}`).join(", "),
        );
      if (openingsAfter.length !== openingsBefore.length)
        throw new Error("fgs_stock_log gained or lost rows — openings must only be restored, never inserted");

      // Adding an outflow stream can only ever LOWER availability. The single
      // sanctioned exception is PD0205, whose 2026-08-06 hand patch this
      // migration reverts — anything else rising means the carry-forward chain
      // was disturbed, not just extended.
      const rises = before
        .map((r: any) => ({ code: r.code, from: Number(r.avail), to: byCode.get(r.code)! }))
        .filter((r) => r.to > r.from && r.code !== "PD0205");
      if (rises.length > 0)
        throw new Error(
          "availability ROSE for " +
            rises.map((r) => `${r.code} ${r.from}->${r.to}`).join(", "),
        );

      // fgs_day's closing and fgs_available MUST agree for every product, on
      // every post-cutover day. If they drift the gate and the sheet disagree,
      // which is the exact failure migration 0063 was written to end.
      const [{ n: drift }] = (await tx.unsafe(`
        SELECT count(*)::int AS n
          FROM (SELECT DISTINCT date FROM fgs_stock_log WHERE date >= DATE '${cutover}') s
          CROSS JOIN LATERAL fgs_day(s.date) fd
         WHERE fd.closing <> fgs_available(fd.product_id, s.date)
      `)) as any[];
      console.log(`\n  fgs_day.closing vs fgs_available disagreements: ${drift}`);
      if (drift !== 0) throw new Error(`${drift} product/day pairs disagree — gate and sheet would drift`);

      // Independent cross-check of the new arithmetic: for every post-cutover
      // day, fgs_day's `dispatched` must equal orders + direct sales computed
      // separately here, WITHOUT reusing the migration's own CTEs. Catches a
      // join fan-out (returns subtracted once per line) or a dropped term.
      const [{ n: mismatch }] = (await tx.unsafe(`
        WITH days AS (
          SELECT DISTINCT date FROM fgs_stock_log WHERE date >= DATE '${cutover}'
        ),
        expect AS (
          SELECT d.date, x.product_id, SUM(x.qty)::int AS qty
            FROM days d
            CROSS JOIN LATERAL (
              SELECT COALESCE(pp.stock_source_product_id, pp.id) AS product_id,
                     SUM(oi.quantity)::int AS qty
                FROM orders o
                JOIN order_items oi ON oi.order_id = o.id
                JOIN products pp ON pp.id = oi.product_id
               WHERE o.stock_deducted AND o.status <> 'cancelled'
                 AND o.delivery_date = d.date
               GROUP BY 1
              UNION ALL
              SELECT COALESCE(pp.stock_source_product_id, pp.id) AS product_id,
                     (SUM(di.quantity) - COALESCE(SUM(g.ret), 0))::int AS qty
                FROM direct_sales ds
                JOIN direct_sale_items di ON di.direct_sale_id = ds.id
                JOIN products pp ON pp.id = di.product_id
                LEFT JOIN LATERAL (
                  SELECT SUM(gpi.returned_quantity)::int AS ret
                    FROM gate_pass_items gpi
                   WHERE gpi.direct_sale_id = ds.id AND gpi.product_id = di.product_id
                ) g ON true
               WHERE ds.status = 'confirmed' AND ds.sale_date = d.date
               GROUP BY 1
              UNION ALL
              SELECT COALESCE(pp.stock_source_product_id, pp.id) AS product_id,
                     SUM(ei.quantity)::int AS qty
                FROM employee_orders eo
                JOIN employee_order_items ei ON ei.employee_order_id = eo.id
                JOIN products pp ON pp.id = ei.product_id
               WHERE eo.status NOT IN ('draft', 'cancelled')
                 AND eo.delivery_date = d.date
               GROUP BY 1
            ) x
           GROUP BY 1, 2
        )
        SELECT count(*)::int AS n
          FROM days d
          CROSS JOIN LATERAL fgs_day(d.date) fd
          LEFT JOIN expect e ON e.date = d.date AND e.product_id = fd.product_id
         WHERE fd.dispatched <> COALESCE(e.qty, 0)
      `)) as any[];
      console.log(`  dispatched vs independent recomputation, mismatches: ${mismatch}`);
      if (mismatch !== 0)
        throw new Error(`${mismatch} product/day dispatched figures do not reconcile`);

      // The whole point: the 2026-08-06 sample must now be visible as outflow.
      const sample = (await tx.unsafe(`
        SELECT opening, received, dispatched, wastage, closing
          FROM fgs_day(DATE '2026-08-06')
         WHERE product_id = (SELECT id FROM products WHERE code = 'PD0205')
      `)) as any[];
      const s = sample[0];
      console.log(
        `\n  PD0205 on 2026-08-06 now reads: opening=${s.opening} received=${s.received} ` +
          `dispatched=${s.dispatched} wastage=${s.wastage} closing=${s.closing}`,
      );

      if (!APPLY) throw new Error("__DRY_RUN__");
    });
  } catch (err: any) {
    if (err?.message === "__DRY_RUN__") {
      console.log(`\n— dry run — rolled back after ${Date.now() - t0}ms. Re-run with --apply to commit.`);
      await sql.end();
      return;
    }
    throw err;
  }

  console.log(`\nCOMMITTED in ${Date.now() - t0}ms`);
  await sql.end();
}

main().catch(async (e) => {
  console.error("\nFAILED — transaction rolled back, nothing changed.");
  console.error(e.message ?? e);
  await sql.end().catch(() => {});
  process.exit(1);
});
