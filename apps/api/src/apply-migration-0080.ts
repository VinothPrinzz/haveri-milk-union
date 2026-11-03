// Applies packages/db/src/migrations/0080_dealer_village_and_start_date.sql.
//
// See apply-migration-0063.ts for why the repo migration runner is never
// pointed at prod (the _migrations table is stale there).
//
// Additive: two columns on dealers (village, agency_start_date) plus a
// one-off backfill of the start date. The customer list, the City/Village
// sales report and the Agency report read both, so apply it BEFORE
// deploying the API.
//
// USAGE (from apps/api):  npx tsx --env-file=.env src/apply-migration-0080.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pgClient } from "./lib/db.js";

const here = dirname(fileURLToPath(import.meta.url));
const sqlPath = join(here, "../../../packages/db/src/migrations/0080_dealer_village_and_start_date.sql");

async function main() {
  const body = readFileSync(sqlPath, "utf8");
  await pgClient.begin(async (_tx) => {
    const tx = _tx as unknown as typeof pgClient;
    await tx.unsafe(body);
  });
  console.log("migration 0080 applied");

  const cols = (await pgClient`
    SELECT column_name AS c, data_type AS t, is_nullable AS n
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'dealers'
       AND column_name IN ('village', 'agency_start_date')
     ORDER BY column_name
  `) as any[];
  for (const c of cols) console.log(`  dealers.${c.c}  ${c.t}  nullable=${c.n}`);
  if (cols.length !== 2) console.log("  COLUMN MISSING");
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => pgClient.end());
