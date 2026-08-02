// Read-only: forensics for the 2026-07-24 ~14:50-15:04 IST API outage.
// Looks for (a) a write-activity gap across the window, (b) evidence of
// long-running / blocked sessions, (c) background job run history.
import { pgClient } from "./lib/db.js";

const WIN_START = "2026-07-24 13:30:00"; // IST
const WIN_END = "2026-07-24 15:45:00"; // IST

async function main() {
  console.log("=== 1. Server-side clock + settings ===");
  const [meta] = await pgClient`
    SELECT now() AT TIME ZONE 'Asia/Kolkata' AS now_ist,
           current_setting('statement_timeout') AS statement_timeout,
           current_setting('idle_in_transaction_session_timeout') AS idle_in_txn_timeout,
           current_setting('lock_timeout') AS lock_timeout,
           current_setting('max_connections') AS max_connections
  `;
  console.log(meta);

  console.log("\n=== 2. Orders created per 5 min (IST) across window ===");
  const orderBuckets = await pgClient`
    SELECT to_char(date_trunc('hour', created_at AT TIME ZONE 'Asia/Kolkata')
             + floor(extract(minute FROM created_at AT TIME ZONE 'Asia/Kolkata')/5)*interval '5 min',
             'HH24:MI') AS bucket,
           count(*) AS n
      FROM orders
     WHERE created_at AT TIME ZONE 'Asia/Kolkata' >= ${WIN_START}::timestamp
       AND created_at AT TIME ZONE 'Asia/Kolkata' <  ${WIN_END}::timestamp
     GROUP BY 1 ORDER BY 1
  `;
  console.table(orderBuckets);

  console.log("\n=== 3. Payments created per 5 min (IST) across window ===");
  const payBuckets = await pgClient`
    SELECT to_char(date_trunc('hour', created_at AT TIME ZONE 'Asia/Kolkata')
             + floor(extract(minute FROM created_at AT TIME ZONE 'Asia/Kolkata')/5)*interval '5 min',
             'HH24:MI') AS bucket,
           count(*) AS n
      FROM payments
     WHERE created_at AT TIME ZONE 'Asia/Kolkata' >= ${WIN_START}::timestamp
       AND created_at AT TIME ZONE 'Asia/Kolkata' <  ${WIN_END}::timestamp
     GROUP BY 1 ORDER BY 1
  `;
  console.table(payBuckets);

  console.log("\n=== 4. Current pg_stat_activity summary (by state) ===");
  const act = await pgClient`
    SELECT state, count(*) AS n,
           max(extract(epoch FROM (now() - state_change)))::int AS oldest_secs
      FROM pg_stat_activity
     WHERE datname = current_database()
     GROUP BY state ORDER BY n DESC
  `;
  console.table(act);

  console.log("\n=== 5. Longest-running current queries (top 10) ===");
  const longest = await pgClient`
    SELECT pid, state,
           extract(epoch FROM (now() - query_start))::int AS runtime_s,
           extract(epoch FROM (now() - xact_start))::int  AS xact_s,
           wait_event_type, wait_event,
           left(regexp_replace(query, '\\s+', ' ', 'g'), 110) AS q
      FROM pg_stat_activity
     WHERE datname = current_database() AND state <> 'idle'
     ORDER BY query_start NULLS LAST
     LIMIT 10
  `;
  console.table(longest);

  console.log("\n=== 6. Any blocked / blocking sessions right now ===");
  const blocked = await pgClient`
    SELECT pid, pg_blocking_pids(pid) AS blocked_by, wait_event_type, wait_event,
           left(regexp_replace(query, '\\s+', ' ', 'g'), 90) AS q
      FROM pg_stat_activity
     WHERE cardinality(pg_blocking_pids(pid)) > 0
  `;
  console.table(blocked);

  console.log("\n=== 7. background_jobs around the window ===");
  try {
    const jobs = await pgClient`
      SELECT id::text, kind, status,
             to_char(created_at AT TIME ZONE 'Asia/Kolkata','HH24:MI:SS') AS created_ist,
             to_char(updated_at AT TIME ZONE 'Asia/Kolkata','HH24:MI:SS') AS updated_ist,
             attempts, left(coalesce(last_error,''), 120) AS last_error
        FROM background_jobs
       WHERE created_at AT TIME ZONE 'Asia/Kolkata' >= ${WIN_START}::timestamp
         AND created_at AT TIME ZONE 'Asia/Kolkata' <  ${WIN_END}::timestamp
       ORDER BY created_at
       LIMIT 60
    `;
    console.table(jobs);
  } catch (e) {
    console.log("background_jobs query failed:", e instanceof Error ? e.message : e);
  }

  console.log("\n=== 8. Stuck background_jobs (any age, not done) ===");
  try {
    const stuck = await pgClient`
      SELECT kind, status, count(*) AS n,
             to_char(min(created_at) AT TIME ZONE 'Asia/Kolkata','MM-DD HH24:MI') AS oldest_ist
        FROM background_jobs
       WHERE status NOT IN ('completed','done','succeeded')
       GROUP BY kind, status ORDER BY n DESC LIMIT 20
    `;
    console.table(stuck);
  } catch (e) {
    console.log("stuck query failed:", e instanceof Error ? e.message : e);
  }

  await pgClient.end();
}

main().catch(async (e) => {
  console.error(e);
  await pgClient.end();
  process.exit(1);
});
