// Read-only stall watcher. Leave this running through the 10:00-11:30 IST
// peak. It samples pg_stat_activity every 10s and, the moment the API goes
// quiet, records WHAT was blocking and on WHAT — the one piece of evidence a
// machine restart destroys.
//
//   cd apps/api && npx tsx src/diag-stall-watch.ts
//
// Prints a compact line every sample; appends full detail to stall-watch.log
// whenever a sample looks unhealthy (blocked sessions, or long-running ones).
import { pgClient } from "./lib/db.js";
import { appendFileSync } from "node:fs";

const SAMPLE_MS = 10_000;
const LOG = "stall-watch.log";
// A sample is "interesting" if anything is blocked, or a statement has been
// running longer than this (the request path should never come close).
const LONG_RUNNING_S = 5;

function ist(): string {
  return new Date(Date.now() + (5 * 60 + 30) * 60 * 1000)
    .toISOString()
    .slice(11, 19);
}

function record(payload: unknown) {
  appendFileSync(LOG, JSON.stringify(payload) + "\n");
}

async function sample() {
  const [counts] = await pgClient`
    SELECT count(*) FILTER (WHERE state = 'active')                        AS active,
           count(*) FILTER (WHERE state = 'idle in transaction')           AS idle_in_txn,
           count(*) FILTER (WHERE state = 'idle')                          AS idle,
           COALESCE(max(extract(epoch FROM (now() - query_start)))
                    FILTER (WHERE state = 'active'), 0)::int               AS longest_active_s
      FROM pg_stat_activity
     WHERE datname = current_database()
  `;

  const blocked = await pgClient`
    SELECT pid,
           pg_blocking_pids(pid)                                   AS blocked_by,
           wait_event_type, wait_event,
           extract(epoch FROM (now() - query_start))::int          AS runtime_s,
           left(regexp_replace(query, '\\s+', ' ', 'g'), 160)      AS q
      FROM pg_stat_activity
     WHERE datname = current_database()
       AND cardinality(pg_blocking_pids(pid)) > 0
  `;

  const longRunning = await pgClient`
    SELECT pid, state, wait_event_type, wait_event,
           extract(epoch FROM (now() - query_start))::int     AS runtime_s,
           extract(epoch FROM (now() - xact_start))::int      AS xact_s,
           left(regexp_replace(query, '\\s+', ' ', 'g'), 160) AS q
      FROM pg_stat_activity
     WHERE datname = current_database()
       AND state <> 'idle'
       AND query_start < now() - make_interval(secs => ${LONG_RUNNING_S})
     ORDER BY query_start
     LIMIT 15
  `;

  const t = ist();
  const unhealthy = blocked.length > 0 || longRunning.length > 0;
  const flag = unhealthy ? "  ⚠️  RECORDED" : "";
  console.log(
    `${t}  active=${counts!.active} idle_in_txn=${counts!.idle_in_txn} ` +
      `idle=${counts!.idle} longest_active=${counts!.longest_active_s}s ` +
      `blocked=${blocked.length}${flag}`
  );

  if (unhealthy) {
    record({ t, counts, blocked, longRunning });
    for (const b of blocked as any[]) {
      console.log(`      blocked pid=${b.pid} by=${b.blocked_by} ` +
                  `wait=${b.wait_event_type}/${b.wait_event} ${b.runtime_s}s :: ${b.q}`);
    }
    for (const l of longRunning as any[]) {
      console.log(`      long    pid=${l.pid} ${l.runtime_s}s (xact ${l.xact_s}s) ` +
                  `wait=${l.wait_event_type}/${l.wait_event} :: ${l.q}`);
    }
  }
}

async function main() {
  console.log(`Watching every ${SAMPLE_MS / 1000}s. Detail → ${LOG}. Ctrl+C to stop.`);
  console.log("Leave this running THROUGH the stall — do not restart the machine first.\n");
  for (;;) {
    try {
      await sample();
    } catch (e) {
      const t = ist();
      const msg = e instanceof Error ? e.message : String(e);
      // A failure to even sample is itself a signal (pooler saturated).
      console.log(`${t}  SAMPLE FAILED: ${msg}`);
      record({ t, sampleError: msg });
    }
    await new Promise((r) => setTimeout(r, SAMPLE_MS));
  }
}

main();
