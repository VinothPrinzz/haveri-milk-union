// Read-only follow-up: confirm the write-activity gap is real (not just a
// quiet time of day) and inspect background_jobs with its actual schema.
import { pgClient } from "./lib/db.js";

async function main() {
  console.log("=== column types ===");
  const cols = await pgClient`
    SELECT table_name, column_name, data_type
      FROM information_schema.columns
     WHERE table_schema='public'
       AND ((table_name='orders' AND column_name IN ('created_at','updated_at'))
        OR (table_name='payments' AND column_name='created_at'))
     ORDER BY table_name, column_name
  `;
  console.table(cols);

  console.log("\n=== background_jobs schema ===");
  const bj = await pgClient`
    SELECT column_name, data_type
      FROM information_schema.columns
     WHERE table_schema='public' AND table_name='background_jobs'
     ORDER BY ordinal_position
  `;
  console.table(bj);

  console.log("\n=== orders per hour, today vs yesterday (IST) ===");
  const perHour = await pgClient`
    SELECT (created_at AT TIME ZONE 'Asia/Kolkata')::date::text AS d,
           to_char(created_at AT TIME ZONE 'Asia/Kolkata','HH24') AS hr,
           count(*) AS n
      FROM orders
     WHERE created_at >= (now() - interval '2 days')
     GROUP BY 1,2 ORDER BY 1,2
  `;
  console.table(perHour);

  console.log("\n=== last 15 orders (IST) ===");
  const last = await pgClient`
    SELECT id::text AS id, status::text AS st,
           to_char(created_at AT TIME ZONE 'Asia/Kolkata','MM-DD HH24:MI:SS') AS created_ist,
           to_char(updated_at AT TIME ZONE 'Asia/Kolkata','MM-DD HH24:MI:SS') AS updated_ist
      FROM orders ORDER BY created_at DESC LIMIT 15
  `;
  console.table(last);

  console.log("\n=== last 15 orders by UPDATED time (catches writes during window) ===");
  const lastUpd = await pgClient`
    SELECT id::text AS id, status::text AS st,
           to_char(updated_at AT TIME ZONE 'Asia/Kolkata','MM-DD HH24:MI:SS') AS updated_ist
      FROM orders ORDER BY updated_at DESC LIMIT 15
  `;
  console.table(lastUpd);

  console.log("\n=== last 20 payments (IST) ===");
  const pays = await pgClient`
    SELECT id::text AS id, mode::text AS mode, amount::numeric AS amt,
           to_char(created_at AT TIME ZONE 'Asia/Kolkata','MM-DD HH24:MI:SS') AS created_ist
      FROM payments ORDER BY created_at DESC LIMIT 20
  `;
  console.table(pays);

  await pgClient.end();
}

main().catch(async (e) => {
  console.error(e);
  await pgClient.end();
  process.exit(1);
});
