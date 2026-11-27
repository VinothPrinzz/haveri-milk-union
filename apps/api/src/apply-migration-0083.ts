// Applies packages/db/src/migrations/0083_dtc_officer_entries.sql
// (Contractor entries recorded by route officers).
//
// See apply-migration-0063.ts for why the repo migration runner is never
// pointed at prod (the _migrations table is stale there).
//
// Additive: one new table (dtc_officer_entries) and the dtc_bill_lines head
// CHECK re-created with the new 'short_supply' head (every existing head is
// kept, so no existing row can fail it). The file is idempotent, so
// re-running is safe.
//
// Apply BEFORE deploying the API: /officer-entries and the DTC bill
// generation (which now reads dtc_officer_entries) depend on it.
//
// USAGE (from apps/api):  npx tsx src/apply-migration-0083.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pgClient } from "./lib/db.js";

const here = dirname(fileURLToPath(import.meta.url));
const file = join(here, "../../../packages/db/src/migrations/0083_dtc_officer_entries.sql");

async function main() {
  const body = readFileSync(file, "utf8");
  await pgClient.begin(async (_tx) => {
    const tx = _tx as unknown as typeof pgClient;
    await tx.unsafe(body);
  });
  console.log("0083_dtc_officer_entries.sql applied");

  const [check] = (await pgClient`
    SELECT
      (SELECT count(*)::int FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'dtc_officer_entries') AS entries_table,
      (SELECT count(*)::int FROM pg_constraint
        WHERE conname = 'dtc_bill_lines_head_check'
          AND pg_get_constraintdef(oid) LIKE '%short_supply%') AS head_check
  `) as any[];
  console.log(`  dtc_officer_entries table: ${check.entries_table} (expect 1)`);
  console.log(`  bill line head check has short_supply: ${check.head_check} (expect 1)`);

  await pgClient.end();
}

main().catch(async (e) => {
  console.error(e);
  await pgClient.end();
  process.exit(1);
});
