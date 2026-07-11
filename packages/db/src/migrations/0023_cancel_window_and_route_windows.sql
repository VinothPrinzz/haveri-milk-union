-- Migration 0023: cancel_window_ends_at on orders + route_id on time_windows
--
-- 1. orders.cancel_window_ends_at — set at confirm time; used by the
--    self-service cancel endpoint to decide direct-cancel vs. admin-request.
--
-- 2. time_windows.route_id — replaces zone_id as the primary keying column.
--    zone_id is made nullable so old rows can be migrated gradually.

-- ── orders ───────────────────────────────────────────────────────────────
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS cancel_window_ends_at timestamptz;

-- ── time_windows ─────────────────────────────────────────────────────────
-- Add route_id (nullable at first so existing rows don't break)
ALTER TABLE time_windows
  ADD COLUMN IF NOT EXISTS route_id uuid
    REFERENCES routes(id) ON DELETE CASCADE;

-- Make zone_id nullable (was NOT NULL + unique before)
ALTER TABLE time_windows
  ALTER COLUMN zone_id DROP NOT NULL;

-- Drop the zone-based unique constraint (one window per zone) so we can
-- have per-route windows. Keep zone_id for backward compat but remove
-- the strict uniqueness.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'time_windows_zone_id_key'
  ) THEN
    ALTER TABLE time_windows DROP CONSTRAINT time_windows_zone_id_key;
  END IF;
END$$;

-- Add unique constraint on route_id (one window per route)
-- Only for rows that have a route_id set.
CREATE UNIQUE INDEX IF NOT EXISTS idx_time_windows_route_id
  ON time_windows (route_id)
  WHERE route_id IS NOT NULL;

-- Index for lookups by zone_id (still used by old code)
CREATE INDEX IF NOT EXISTS idx_time_windows_zone_id
  ON time_windows (zone_id)
  WHERE zone_id IS NOT NULL;
