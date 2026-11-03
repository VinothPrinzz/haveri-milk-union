// Applies packages/db/src/migrations/0079_orders_is_subsidy.sql.
//
// See apply-migration-0063.ts for why the repo migration runner is never
// pointed at prod (the _migrations table is stale there).
//
// Additive: one NOT NULL column with a constant default on orders — no row
// is read or rewritten. The API's subsidy-place and the day's-order lookups
// read it, so apply it BEFORE deploying the API (and the worker).
//
// USAGE (from apps/api):  npx tsx --env-file=.env src/apply-migration-0079.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pgClient } from "./lib/db.js";

const here = dirname(fileURLToPath(import.meta.url));
const sqlPath = join(here, "../../../packages/db/src/migrations/0079_orders_is_subsidy.sql");

async function main() {
  const body = readFileSync(sqlPath, "utf8");
  await pgClient.begin(async (_tx) => {
    const tx = _tx as unknown as typeof pgClient;
    await tx.unsafe(body);
  });
  console.log("migration 0079 applied");

  const [col] = (await pgClient`
    SELECT data_type AS t, is_nullable AS n, column_default AS d
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'is_subsidy'
  `) as any[];
  console.log(col ? `  orders.is_subsidy  ${col.t}  nullable=${col.n}  default=${col.d}` : "  COLUMN MISSING");
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => pgClient.end());
