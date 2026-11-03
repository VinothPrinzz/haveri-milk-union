// Applies packages/db/src/migrations/0081_dtc_billing.sql (DTC Billing).
//
// See apply-migration-0063.ts for why the repo migration runner is never
// pointed at prod (the _migrations table is stale there).
//
// Additive: five new contractor columns (IFSC, PAN, TDS details), ten new
// dtc_* tables, three system_settings rows (ON CONFLICT DO NOTHING), and a
// first billing-terms version per route copied from routes.rate_per_trip /
// total_km_per_day. No existing row is rewritten. The file is idempotent, so
// re-running is safe.
//
// Apply BEFORE deploying the API: the /dtc endpoints and the contractor
// create / update endpoints (new IFSC / PAN / TDS columns) depend on it.
//
// USAGE (from apps/api):  npx tsx src/apply-migration-0081.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pgClient } from "./lib/db.js";

const here = dirname(fileURLToPath(import.meta.url));
const file = join(here, "../../../packages/db/src/migrations/0081_dtc_billing.sql");

async function main() {
  const body = readFileSync(file, "utf8");
  await pgClient.begin(async (_tx) => {
    const tx = _tx as unknown as typeof pgClient;
    await tx.unsafe(body);
  });
  console.log("0081_dtc_billing.sql applied");

  const [check] = (await pgClient`
    SELECT
      (SELECT count(*)::int FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name LIKE 'dtc\\_%') AS tables,
      (SELECT count(*)::int FROM information_schema.columns
        WHERE table_name = 'contractors'
          AND column_name IN ('ifsc_code', 'pan_number', 'tds_entity_type', 'tds_declaration_fy')) AS contractor_cols,
      (SELECT count(*)::int FROM system_settings WHERE category = 'dtc') AS settings,
      (SELECT count(*)::int FROM dtc_route_terms) AS terms
  `) as any[];
  console.log(`  dtc tables: ${check.tables} (expect 10)`);
  console.log(`  new contractor columns: ${check.contractor_cols} (expect 4)`);
  console.log(`  dtc settings rows: ${check.settings} (expect 3)`);
  console.log(`  route terms rows: ${check.terms} (one per route that had a rate)`);

  await pgClient.end();
}

main().catch(async (e) => {
  console.error(e);
  await pgClient.end();
  process.exit(1);
});
