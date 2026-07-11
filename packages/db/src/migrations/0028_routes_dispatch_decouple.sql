-- ════════════════════════════════════════════════════════════════════
-- Haveri Milk Union — Routes ↔ Zones decouple + dispatch_time owner
-- 0028_routes_dispatch_decouple.sql
--
-- Client correction: routes are not taluka-scoped, and dispatch time
-- belongs to the route (not the batch). The previous design had:
--   • routes.zone_id   NOT NULL FK → zones        ← drop
--   • routes.dispatch_time  text  (e.g. "5:30 AM") ← convert to time
--   • batches.dispatch_time time  (introduced 0013, overrode route)  ← drop
--
-- After this migration:
--   • routes have no zone affiliation
--   • routes.dispatch_time is a proper time(0)
--   • batches no longer carry dispatch_time at all
--
-- Pre-flight: log rows whose existing dispatch_time text doesn't match
-- "H:MM AM/PM" or "HH:MM" so an operator can fix them post-migration.
-- Anything unparseable becomes NULL (safer than refusing to migrate).
--
-- Idempotent — safe to re-run. Once columns are dropped, the parse
-- block becomes a no-op because the columns/types no longer exist.
-- ════════════════════════════════════════════════════════════════════

-- ── 1. routes.dispatch_time: text → time(0) ─────────────────────────
DO $$
DECLARE
  bad_count int;
  col_type  text;
BEGIN
  -- Skip if already migrated to time.
  SELECT data_type INTO col_type
    FROM information_schema.columns
   WHERE table_name = 'routes' AND column_name = 'dispatch_time';

  IF col_type IS NULL THEN
    RAISE NOTICE 'routes.dispatch_time column is missing — skipping conversion';
    RETURN;
  END IF;

  IF col_type IN ('time without time zone', 'time with time zone') THEN
    RAISE NOTICE 'routes.dispatch_time is already a time type — skipping conversion';
    RETURN;
  END IF;

  -- Count rows that won't survive the parse so the operator knows.
  EXECUTE $sql$
    SELECT count(*) FROM routes
     WHERE dispatch_time IS NOT NULL
       AND trim(dispatch_time) <> ''
       AND dispatch_time !~* '^\s*[0-9]{1,2}:[0-9]{2}\s*(AM|PM)?\s*$'
  $sql$ INTO bad_count;

  IF bad_count > 0 THEN
    RAISE NOTICE
      '% routes have dispatch_time that does not match "H:MM AM/PM" or "HH:MM" — they will become NULL. Run "SELECT id, code, name, dispatch_time FROM routes WHERE dispatch_time IS NOT NULL" before this migration to inspect.',
      bad_count;
  END IF;
END $$;

-- The actual conversion. Three branches:
--   (a) "5:30 AM" / "5:30am" / mixed-case AM-PM       → 12h parse
--   (b) "05:30" / "5:30"                              → 24h parse
--   (c) anything else (including empty/garbage)       → NULL
ALTER TABLE routes
  ALTER COLUMN dispatch_time TYPE time(0) USING (
    CASE
      WHEN dispatch_time IS NULL                     THEN NULL
      WHEN trim(dispatch_time) = ''                  THEN NULL
      WHEN dispatch_time ~* '^\s*[0-9]{1,2}:[0-9]{2}\s*(AM|PM)\s*$' THEN
        -- Normalise "5:30am" → "5:30 AM" then parse
        to_timestamp(
          regexp_replace(
            regexp_replace(upper(trim(dispatch_time)), '([0-9])(AM|PM)', '\1 \2'),
            '\s+', ' ', 'g'
          ),
          'FMHH12:MI AM'
        )::time
      WHEN dispatch_time ~ '^\s*[0-9]{1,2}:[0-9]{2}\s*$' THEN
        trim(dispatch_time)::time
      ELSE NULL
    END
  );


-- ── 2. Drop routes.zone_id ──────────────────────────────────────────
-- DROP COLUMN cascades any FK constraint on zone_id automatically.
-- No other table references this column (dealers / users / banners /
-- time_windows each have their own zone_id; nothing FKs to routes.zone_id).
ALTER TABLE routes DROP COLUMN IF EXISTS zone_id;


-- ── 3. Drop batches.dispatch_time ───────────────────────────────────
-- Per client correction: dispatch time is per-route, not per-batch.
-- Application code (dispatch-sheet.ts / reports.ts) must be updated
-- to stop referencing this column before this migration deploys —
-- check the corresponding code change for COALESCE(b.dispatch_time, …)
-- removals.
ALTER TABLE batches DROP COLUMN IF EXISTS dispatch_time;


-- ════════════════════════════════════════════════════════════════════
-- Done. Schema state after:
--   routes:   - zone_id          (dropped)
--             - dispatch_time    (now time(0), nullable)
--   batches:  - dispatch_time    (dropped)
--
-- Frontend / backend changes that must ship together:
--   • Route form: drop Taluka field, add Dispatch Time field
--   • Batch form: drop Dispatch Time field
--   • API routes.ts / batches.ts: update zod schemas + SQL
--   • API dispatch-sheet.ts / reports.ts: COALESCE(b.dispatch_time, ...) → r.dispatch_time
--   • normalizeRoute: drop taluka/zoneId, keep dispatchTime
--   • normalizeBatch: drop dispatchTime
-- ════════════════════════════════════════════════════════════════════
