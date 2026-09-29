// Applies packages/db/src/migrations/0066_direct_sales_dispatched_at.sql.
//
// See apply-migration-0063.ts for why the repo migration runner is never
// pointed at prod (the _migrations table is stale there).
//
// Pure additive DDL — one nullable column + a partial index. No existing row
// is read or rewritten, so this is safe to run against a live API. The
// dispatch-sheet endpoints that read the column ship with the next deploy;
// running this first just means the column is already there.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pgClient } from "./lib/db.js";

const here = dirname(fileURLToPath(import.meta.url));
const sqlPath = join(here, "../../../packages/db/src/migrations/0066_direct_sales_dispatched_at.sql");

async function main() {
  const body = readFileSync(sqlPath, "utf8")
    .replace(/^\s*BEGIN\s*;\s*$/gim, "")
    .replace(/^\s*COMMIT\s*;\s*$/gim, "");

  await pgClient.begin(async (_tx) => {
    const tx = _tx as unknown as typeof pgClient;
    await tx.unsafe(body);
  });
  console.log("migration 0066 applied");

  const [{ has_col }] = (await pgClient`
    SELECT count(*)::int AS has_col
      FROM information_schema.columns
     WHERE table_name = 'direct_sales' AND column_name = 'dispatched_at'
  `) as any[];
  const [{ n_open }] = (await pgClient`
    SELECT count(*)::int AS n_open
      FROM direct_sales
     WHERE dispatched_at IS NULL
  `) as any[];
  console.log(`direct_sales.dispatched_at present: ${has_col === 1}`);
  console.log(`direct_sales rows not yet dispatched: ${n_open}`);

  await pgClient.end();
}

main().catch(async (e) => { console.error(e); await pgClient.end(); process.exit(1); });
