// Applies packages/db/src/migrations/0077_adjustment_reason_leakage_incentive.sql
// and 0078_leakage_incentive.sql (Finance → Leakage Incentive).
//
// See apply-migration-0063.ts for why the repo migration runner is never
// pointed at prod (the _migrations table is stale there).
//
// Two transactions, in order: 0077 adds the 'leakage_incentive' value to the
// adjustment_reason enum, and PostgreSQL will not let a value be used in the
// transaction that added it. Both files are idempotent, so re-running is safe.
//
// Additive: one enum value, two new tables, three system_settings rows
// (ON CONFLICT DO NOTHING). No existing row is read or rewritten. The API's
// /finance/leakage-incentive endpoints depend on it — apply BEFORE deploying.
//
// USAGE (from apps/api):  npx tsx src/apply-migration-0078.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pgClient } from "./lib/db.js";

const here = dirname(fileURLToPath(import.meta.url));
const migrations = join(here, "../../../packages/db/src/migrations");
const files = [
  "0077_adjustment_reason_leakage_incentive.sql",
  "0078_leakage_incentive.sql",
];

async function main() {
  for (const f of files) {
    const body = readFileSync(join(migrations, f), "utf8")
      .replace(/^\s*BEGIN\s*;\s*$/gim, "")
      .replace(/^\s*COMMIT\s*;\s*$/gim, "");
    await pgClient.begin(async (_tx) => {
      const tx = _tx as unknown as typeof pgClient;
      await tx.unsafe(body);
    });
    console.log(`${f} applied`);
  }

  const [check] = (await pgClient`
    SELECT
      EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
               WHERE t.typname = 'adjustment_reason' AND e.enumlabel = 'leakage_incentive') AS enum_ok,
      to_regclass('public.leakage_incentive_runs')  IS NOT NULL AS runs_ok,
      to_regclass('public.leakage_incentive_lines') IS NOT NULL AS lines_ok,
      (SELECT count(*)::int FROM system_settings
        WHERE category = 'finance' AND key LIKE 'leakage_incentive_%') AS settings
  `) as any[];
  console.log(`  enum value 'leakage_incentive': ${check.enum_ok}`);
  console.log(`  leakage_incentive_runs: ${check.runs_ok}  leakage_incentive_lines: ${check.lines_ok}`);
  console.log(`  settings rows: ${check.settings} (expect 3)`);

  await pgClient.end();
}

main().catch(async (e) => {
  console.error(e);
  await pgClient.end();
  process.exit(1);
});
