-- ════════════════════════════════════════════════════════════════════
-- 0052 — Per-route contractor rates
--
-- A contractor serving 2+ routes is paid a different rate for each route,
-- and each route has its own total km per day. Move these from the single
-- contractor-level `contractors.rate_per_km` onto the per-route relationship
-- (one contractor : many routes via routes.contractor_id).
--
--   • routes.rate_per_trip    — rate per km/trip for this route
--   • routes.total_km_per_day — total km per day for this route
--
-- The old contractors.rate_per_km column is left in place (deprecated) but is
-- no longer surfaced in the contractor form. Existing rates are backfilled
-- onto the routes each contractor is currently assigned to.
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE routes ADD COLUMN IF NOT EXISTS rate_per_trip    numeric(10, 2);
ALTER TABLE routes ADD COLUMN IF NOT EXISTS total_km_per_day numeric(10, 2);

-- Backfill: carry each contractor's old single rate onto its assigned routes
UPDATE routes r
SET rate_per_trip = c.rate_per_km
FROM contractors c
WHERE r.contractor_id = c.id
  AND r.rate_per_trip IS NULL
  AND c.rate_per_km IS NOT NULL;
