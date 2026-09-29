// ═══════════════════════════════════════════════════════════════════════
// diag-apply-0073.ts — applies 0073_district_haveri_only.sql directly
// (the repo's migration runner is not used against prod: _migrations is
// stale). The file is one BEGIN/COMMIT block, so it is sent as a single
// simple query and either lands whole or not at all.
//
// USAGE (from apps/api):  npx tsx src/diag-apply-0073.ts
// ═══════════════════════════════════════════════════════════════════════
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pgClient } from "./lib/db.js";

const here = dirname(fileURLToPath(import.meta.url));
const sqlPath = join(here, "../../../packages/db/src/migrations/0073_district_haveri_only.sql");
const sql = readFileSync(sqlPath, "utf8");

const before = await pgClient`
  SELECT count(*) FILTER (WHERE COALESCE(city, '') <> 'Haveri')::int AS not_haveri,
         count(*)::int AS total
    FROM dealers
`;
console.log("before:", before[0]);

// postgres.js refuses a script that opens its own transaction, so the
// BEGIN/COMMIT wrapper is stripped and sql.begin() supplies it instead.
// .simple() = simple query protocol, the only mode that accepts a
// multi-statement script.
const body = sql.replace(/^\s*BEGIN\s*;/im, "").replace(/^\s*COMMIT\s*;/im, "");
await pgClient.begin(async (tx) => {
  await (tx as unknown as typeof pgClient).unsafe(body).simple();
});
console.log("applied 0073_district_haveri_only.sql");

const after = await pgClient`
  SELECT COALESCE(NULLIF(TRIM(city), ''), '(blank)') AS city, count(*)::int AS n
    FROM dealers GROUP BY 1 ORDER BY n DESC
`;
console.log("after (dealers.city):");
console.table(after);

const [backup] = await pgClient`
  SELECT count(*)::int AS rows,
         count(DISTINCT old_city)::int AS distinct_old_values
    FROM backup_district.dealers_city_20260813
`;
console.log("backup table:", backup);

const [cities] = await pgClient`
  SELECT value FROM system_settings WHERE category = 'marketing' AND key = 'cities'
`;
console.log("marketing.cities:", cities?.value);

const [defs] = await pgClient`
  SELECT (SELECT column_default FROM information_schema.columns
           WHERE table_name = 'dealers' AND column_name = 'city')     AS dealers_city_default,
         (SELECT column_default FROM information_schema.columns
           WHERE table_name = 'contractors' AND column_name = 'city') AS contractors_city_default
`;
console.log("column defaults:", defs);

await pgClient.end();
