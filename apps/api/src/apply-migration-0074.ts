// Applies packages/db/src/migrations/0074_ist_calendar_day.sql.
//
// See apply-migration-0063.ts for why the repo migration runner is never
// pointed at prod (the _migrations table is stale there).
//
// Two column DEFAULTs and two comments. No existing row is read or
// rewritten and no code path depends on this having run, so it is safe to
// apply to a live API at any time, before or after the deploy.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pgClient } from "./lib/db.js";

const here = dirname(fileURLToPath(import.meta.url));
const sqlPath = join(here, "../../../packages/db/src/migrations/0074_ist_calendar_day.sql");

async function main() {
  const body = readFileSync(sqlPath, "utf8")
    .replace(/^\s*BEGIN\s*;\s*$/gim, "")
    .replace(/^\s*COMMIT\s*;\s*$/gim, "");

  await pgClient.begin(async (_tx) => {
    const tx = _tx as unknown as typeof pgClient;
    await tx.unsafe(body);
  });
  console.log("migration 0074 applied");

  const defs = (await pgClient`
    SELECT table_name AS t, column_default AS def
      FROM information_schema.columns
     WHERE table_schema = 'public' AND column_name = 'received_date'
       AND table_name IN ('payments', 'cheques')
     ORDER BY table_name
  `) as any[];
  for (const d of defs) console.log(`  ${d.t}.received_date DEFAULT ${d.def}`);

  // The boundary the DEFAULT now lands on: 23:59:59 IST and 00:00:00 IST
  // must fall on different days, and a 02:00 IST insert must take the new
  // day rather than the one a bare CURRENT_DATE would still be serving.
  const [b] = (await pgClient`
    SELECT (('2026-09-07 18:29:59+00'::timestamptz) AT TIME ZONE 'Asia/Kolkata')::date::text AS "lastSecondOf7th",
           (('2026-09-07 18:30:00+00'::timestamptz) AT TIME ZONE 'Asia/Kolkata')::date::text AS "firstSecondOf8th",
           (('2026-09-07 20:30:00+00'::timestamptz) AT TIME ZONE 'Asia/Kolkata')::date::text AS "twoAmOn8th",
           ('2026-09-07 20:30:00+00'::timestamptz)::date::text                               AS "twoAmBareCast"
  `) as any[];
  console.log(`  23:59:59 IST on the 7th -> ${b.lastSecondOf7th}`);
  console.log(`  00:00:00 IST on the 8th -> ${b.firstSecondOf8th}`);
  console.log(`  02:00:00 IST on the 8th -> ${b.twoAmOn8th}   (a bare ::date still says ${b.twoAmBareCast})`);
  console.log(
    `  boundary is midnight IST: ${
      b.lastSecondOf7th === "2026-09-07" &&
      b.firstSecondOf8th === "2026-09-08" &&
      b.twoAmOn8th === "2026-09-08"
    }`,
  );

  await pgClient.end();
}

main().catch(async (e) => {
  console.error(e);
  await pgClient.end();
  process.exit(1);
});
