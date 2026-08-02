// Read-only: why the API stalls ~5 min at roughly the same time every day.
// Hypothesis under test: the every-5-min AutoConfirm job fires from
// (close_time − warning_minutes) through (close_time + 15 min) and serially
// walks every dealer on the route, saturating the 10-connection pool.
import { pgClient } from "./lib/db.js";

async function main() {
  console.log("=== 1. Clock + timeout settings ===");
  const [meta] = await pgClient`
    SELECT now() AT TIME ZONE 'Asia/Kolkata' AS now_ist,
           current_setting('statement_timeout') AS statement_timeout,
           current_setting('idle_in_transaction_session_timeout') AS idle_in_txn_timeout,
           current_setting('max_connections') AS max_connections
  `;
  console.log(meta);

  console.log("\n=== 2. Ordering windows per route (IST) ===");
  const windows = await pgClient`
    SELECT r.name AS route,
           tw.*
      FROM time_windows tw
      JOIN routes r ON r.id = tw.route_id
     ORDER BY tw.close_time
  `;
  console.table(windows);

  console.log("\n=== 3. AutoConfirm busy band per route (warning → close+15) ===");
  const band = await pgClient`
    SELECT r.name AS route,
           (tw.close_time - make_interval(mins => tw.warning_minutes))::text AS busy_from,
           (tw.close_time + interval '15 minutes')::text AS busy_until,
           tw.warning_minutes,
           tw.active,
           (SELECT count(*) FROM dealer_routes dr
             JOIN dealers d ON d.id = dr.dealer_id
            WHERE dr.route_id = r.id AND d.active = true AND d.deleted_at IS NULL
           ) AS dealers_walked
      FROM time_windows tw
      JOIN routes r ON r.id = tw.route_id
     WHERE tw.active = true
     ORDER BY tw.close_time
  `;
  console.table(band);

  console.log("\n=== 4. Orders created per 5 min today (IST) — burst shape ===");
  const buckets = await pgClient`
    SELECT to_char(date_trunc('hour', created_at AT TIME ZONE 'Asia/Kolkata')
             + floor(extract(minute FROM created_at AT TIME ZONE 'Asia/Kolkata')/5)*interval '5 min',
             'HH24:MI') AS bucket,
           count(*) AS n
      FROM orders
     WHERE (created_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date
     GROUP BY 1 ORDER BY 1
  `;
  console.table(buckets);

  console.log("\n=== 5. Top queries by TOTAL time (pg_stat_statements) ===");
  try {
    const top = await pgClient`
      SELECT round(total_exec_time)::int AS total_ms,
             calls,
             round(mean_exec_time)::int  AS mean_ms,
             round(max_exec_time)::int   AS max_ms,
             left(regexp_replace(query, '\\s+', ' ', 'g'), 100) AS q
        FROM pg_stat_statements
       ORDER BY total_exec_time DESC
       LIMIT 15
    `;
    console.table(top);
  } catch (e) {
    console.log("pg_stat_statements unavailable:", e instanceof Error ? e.message : e);
  }

  console.log("\n=== 6. Current activity by state ===");
  const act = await pgClient`
    SELECT state, count(*) AS n,
           max(extract(epoch FROM (now() - state_change)))::int AS oldest_secs
      FROM pg_stat_activity
     WHERE datname = current_database()
     GROUP BY state ORDER BY n DESC
  `;
  console.table(act);

  await pgClient.end();
}

main().catch(async (e) => {
  console.error(e);
  await pgClient.end();
  process.exit(1);
});
