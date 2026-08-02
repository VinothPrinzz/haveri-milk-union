// Read-only: does the API go silent at the same minute every day?
// Finds the largest gap between consecutive order writes in the 10:00-11:30
// IST band, per day, for the last 14 days. A recurring multi-minute gap at a
// fixed clock time is an outage signature, not organic traffic variation.
import { pgClient } from "./lib/db.js";

async function main() {
  console.log("=== Largest quiet gap per day, 10:00-11:30 IST (last 14 days) ===");
  const gaps = await pgClient`
    WITH e AS (
      SELECT (created_at AT TIME ZONE 'Asia/Kolkata') AS ts
        FROM orders
       WHERE created_at >= now() - interval '14 days'
    ),
    w AS (
      SELECT ts::date AS d,
             ts,
             LAG(ts) OVER (PARTITION BY ts::date ORDER BY ts) AS prev
        FROM e
       WHERE ts::time BETWEEN '10:00' AND '11:30'
    )
    SELECT DISTINCT ON (d)
           d::text                                        AS day,
           to_char(prev, 'HH24:MI:SS')                    AS quiet_from,
           to_char(ts,   'HH24:MI:SS')                    AS resumed_at,
           round(extract(epoch FROM (ts - prev)))::int    AS gap_secs
      FROM w
     WHERE prev IS NOT NULL
     ORDER BY d DESC, gap_secs DESC
  `;
  console.table(gaps);

  console.log("\n=== Same, for the 18:00-20:30 IST evening bands ===");
  const evening = await pgClient`
    WITH e AS (
      SELECT (created_at AT TIME ZONE 'Asia/Kolkata') AS ts
        FROM orders
       WHERE created_at >= now() - interval '14 days'
    ),
    w AS (
      SELECT ts::date AS d, ts,
             LAG(ts) OVER (PARTITION BY ts::date ORDER BY ts) AS prev
        FROM e
       WHERE ts::time BETWEEN '18:00' AND '20:30'
    )
    SELECT DISTINCT ON (d)
           d::text AS day,
           to_char(prev, 'HH24:MI:SS') AS quiet_from,
           to_char(ts,   'HH24:MI:SS') AS resumed_at,
           round(extract(epoch FROM (ts - prev)))::int AS gap_secs
      FROM w
     WHERE prev IS NOT NULL
     ORDER BY d DESC, gap_secs DESC
  `;
  console.table(evening);

  await pgClient.end();
}

main().catch(async (e) => {
  console.error(e);
  await pgClient.end();
  process.exit(1);
});
