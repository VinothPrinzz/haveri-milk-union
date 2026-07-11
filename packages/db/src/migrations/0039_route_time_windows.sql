-- ════════════════════════════════════════════════════════════════════
-- Haveri Milk Union — Per-Route Time Windows
-- 0039_route_time_windows.sql
--
-- Moves the ordering window from zone-scoped to route-scoped. Until now
-- time_windows.zone_id was UNIQUE NOT NULL (one window per zone). The
-- dealer app keys everything on routes from here on, so each route gets
-- its own window.
--
-- zone_id is kept (nullable) through the transition so anything still
-- reading it doesn't break. A later migration can drop it.
-- Idempotent — safe to re-run.
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE time_windows
  ADD COLUMN IF NOT EXISTS route_id uuid REFERENCES routes(id) ON DELETE CASCADE;

-- zone_id no longer required, and no longer unique.
ALTER TABLE time_windows ALTER COLUMN zone_id DROP NOT NULL;
ALTER TABLE time_windows DROP CONSTRAINT IF EXISTS time_windows_zone_id_key;
ALTER TABLE time_windows DROP CONSTRAINT IF EXISTS time_windows_zone_id_unique;

-- One window per route, seeded from each route's zone window.
INSERT INTO time_windows (route_id, open_time, warning_minutes, close_time, active)
SELECT r.id, tw.open_time, tw.warning_minutes, tw.close_time, tw.active
FROM routes r
JOIN time_windows tw ON tw.route_id = r.id
WHERE r.deleted_at IS NULL
  AND tw.route_id IS NULL
ON CONFLICT DO NOTHING;

-- Drop the now-orphaned zone-only rows (those never had a route_id set).
DELETE FROM time_windows WHERE route_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_time_windows_route
  ON time_windows (route_id);