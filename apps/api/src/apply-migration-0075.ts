// Applies packages/db/src/migrations/0075_price_revisions_dealer_price_mrp.sql.
//
// See apply-migration-0063.ts for why the repo migration runner is never
// pointed at prod (the _migrations table is stale there).
//
// Additive: four nullable columns, one defaulted column and a CHECK on
// price_revisions. No existing row is read or rewritten (the table has never
// held a row). Unlike 0074, code DOES depend on this: the API's product edit
// and Price Revisions save both write the new columns. Apply it BEFORE
// deploying the API, or every product edit will fail.
//
// USAGE (from apps/api):  npx tsx src/apply-migration-0075.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pgClient } from "./lib/db.js";

const here = dirname(fileURLToPath(import.meta.url));
const sqlPath = join(here, "../../../packages/db/src/migrations/0075_price_revisions_dealer_price_mrp.sql");

async function main() {
  const body = readFileSync(sqlPath, "utf8")
    .replace(/^\s*BEGIN\s*;\s*$/gim, "")
    .replace(/^\s*COMMIT\s*;\s*$/gim, "");

  await pgClient.begin(async (_tx) => {
    const tx = _tx as unknown as typeof pgClient;
    await tx.unsafe(body);
  });
  console.log("migration 0075 applied");

  const cols = (await pgClient`
    SELECT column_name AS c, data_type AS t, is_nullable AS n, column_default AS d
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'price_revisions'
       AND column_name IN ('old_dealer_price', 'new_dealer_price', 'old_mrp', 'new_mrp', 'source')
     ORDER BY ordinal_position
  `) as any[];
  for (const c of cols) console.log(`  price_revisions.${c.c}  ${c.t}  nullable=${c.n}  default=${c.d ?? "none"}`);
  console.log(`  all 5 columns present: ${cols.length === 5}`);

  await pgClient.end();
}

main().catch(async (e) => {
  console.error(e);
  await pgClient.end();
  process.exit(1);
});
