// Applies packages/db/src/migrations/0065_supplier_product_costs.sql.
//
// See apply-migration-0063.ts for why the repo migration runner is never
// pointed at prod (the _migrations table is stale there).
//
// Pure additive DDL — one new table, no existing row is read or rewritten,
// so this is safe to run against a live API. The new endpoints ship with the
// next API deploy; running this first just means the table is already there.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pgClient } from "./lib/db.js";

const here = dirname(fileURLToPath(import.meta.url));
const sqlPath = join(here, "../../../packages/db/src/migrations/0065_supplier_product_costs.sql");

async function main() {
  const body = readFileSync(sqlPath, "utf8")
    .replace(/^\s*BEGIN\s*;\s*$/gim, "")
    .replace(/^\s*COMMIT\s*;\s*$/gim, "");

  await pgClient.begin(async (_tx) => {
    const tx = _tx as unknown as typeof pgClient;
    await tx.unsafe(body);
  });
  console.log("migration 0065 applied");

  const [{ n }] = (await pgClient`
    SELECT count(*)::int AS n FROM supplier_product_costs
  `) as any[];
  const [{ cols }] = (await pgClient`
    SELECT string_agg(column_name, ', ' ORDER BY ordinal_position) AS cols
      FROM information_schema.columns
     WHERE table_name = 'supplier_product_costs'
  `) as any[];
  console.log(`supplier_product_costs: ${n} rows`);
  console.log(`columns: ${cols}`);

  await pgClient.end();
}

main().catch(async (e) => { console.error(e); await pgClient.end(); process.exit(1); });
