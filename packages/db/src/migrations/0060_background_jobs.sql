-- ════════════════════════════════════════════════════════════════════
-- 0060_background_jobs.sql
--
-- Postgres-based job outbox replacing BullMQ/Redis (Upstash).
--
-- WHY: on per-command-billed Redis, BullMQ's idle polling alone cost
-- ~560K commands/day (~$50+/month) with zero jobs processed — 8 workers
-- each doing a 10s blocking wait + a multi-command Lua "move to active"
-- script on every wake. Actual business traffic (pushes, PDFs) is a few
-- hundred jobs/day. A tiny outbox table on the existing Supabase
-- Postgres (no per-command billing) polled every 5s by the worker
-- replaces all of it at $0.
--
-- Lifecycle: rows are inserted 'pending', claimed 'processing' by the
-- worker (FOR UPDATE SKIP LOCKED), DELETEd on success, retried with
-- exponential backoff until max_attempts, then parked as 'failed' for
-- inspection (purged after 7 days by the worker's daily cleanup cron).
-- A 'processing' row untouched for 5+ minutes is presumed orphaned by a
-- worker crash and is re-claimed.
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS background_jobs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  queue        text NOT NULL,                      -- 'push-notifications' | 'pdf-invoice'
  name         text NOT NULL DEFAULT '',           -- human-readable job label for logs
  data         jsonb NOT NULL DEFAULT '{}'::jsonb,
  status       text NOT NULL DEFAULT 'pending',    -- pending | processing | failed
  attempts     int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 1,
  run_at       timestamptz NOT NULL DEFAULT now(), -- earliest time the job may run
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Serves the worker's claim query; partial → stays tiny since finished
-- jobs are deleted.
CREATE INDEX IF NOT EXISTS idx_background_jobs_claim
  ON background_jobs (run_at)
  WHERE status IN ('pending', 'processing');
