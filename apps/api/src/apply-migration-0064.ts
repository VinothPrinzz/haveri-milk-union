// Applies packages/db/src/migrations/0064_fgs_freeze_pre_cutover_history.sql.
//
// See apply-migration-0063.ts for why the file's BEGIN/COMMIT are stripped
// (postgres.js UNSAFE_TRANSACTION guard) and why the repo migration runner is
// never pointed at prod.
//
// fgs_day is a DB function, so this takes effect immediately for the running
// API — no redeploy needed to restore the historical sheets.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pgClient } from "./lib/db.js";

const here = dirname(fileURLToPath(import.meta.url));
const sqlPath = join(here, "../../../packages/db/src/migrations/0064_fgs_freeze_pre_cutover_history.sql");

async function main() {
  const [{ d: today }] = await pgClient`
    SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS d
  ` as any[];

  const before = new Map(
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
  await pgClient.begin(async (_tx) => {
    const tx = _tx as unknown as typeof pgClient;
    await tx.unsafe(body);
  });
  console.log("migration 0064 applied");

  const after = (await pgClient`
    SELECT p.id::text AS id, p.code,
           GREATEST(COALESCE(fd.closing, 0), 0)::int AS stock
      FROM products p
      LEFT JOIN fgs_day(${today}::date) fd ON fd.product_id = p.id
     WHERE p.deleted_at IS NULL AND p.available = true
  `) as any[];
  const moved = after.filter(a => Number(before.get(a.id)?.stock) !== Number(a.stock));
  console.log(`today's dealer-visible stock moved: ${moved.length} of ${after.length}`);
  for (const m of moved.slice(0, 10)) {
    console.log(`  ${m.code}: ${before.get(m.id)?.stock} → ${m.stock}`);
  }

  await pgClient.end();
}

main().catch(async (e) => { console.error(e); await pgClient.end(); process.exit(1); });
