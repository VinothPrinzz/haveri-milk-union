-- ════════════════════════════════════════════════════════════════════
-- Haveri Milk Union — Dealer Routes Junction
-- 0010_dealer_routes.sql
--
-- Problem: dealers.route_id is a single FK. We need dealers to be
-- assignable to *multiple* routes at once.
--
-- Solution: add a dealer_routes junction table (same pattern as
-- batch_routes). Keep dealers.route_id as the "primary" route for
-- backward compat — the UI still picks one as primary so the order
-- query path doesn't need to change.
--
-- Idempotent — safe to re-run.
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS dealer_routes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dealer_id  uuid NOT NULL REFERENCES dealers(id) ON DELETE CASCADE,
  route_id   uuid NOT NULL REFERENCES routes(id)  ON DELETE CASCADE,
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dealer_id, route_id)
);

CREATE INDEX IF NOT EXISTS idx_dealer_routes_dealer ON dealer_routes (dealer_id);
CREATE INDEX IF NOT EXISTS idx_dealer_routes_route  ON dealer_routes (route_id);

-- Only one primary route per dealer (enforced at DB level).
CREATE UNIQUE INDEX IF NOT EXISTS uq_dealer_routes_primary
  ON dealer_routes (dealer_id) WHERE is_primary = true;

-- ── Backfill from existing dealers.route_id ──
-- For each dealer that already has a route_id, create one junction row
-- marked as primary. Future assignments append without removing this.
INSERT INTO dealer_routes (dealer_id, route_id, is_primary)
SELECT d.id, d.route_id, true
FROM dealers d
WHERE d.route_id IS NOT NULL
  AND d.deleted_at IS NULL
ON CONFLICT (dealer_id, route_id) DO NOTHING;

-- ════════════════════════════════════════════════════════════════════
-- Done. After this:
--   • Every existing dealer with a route_id has one dealer_routes row.
--   • New route assignments INSERT a new row (keeping existing ones).
--   • Removing a route DELETEs the junction row.
--   • dealers.route_id still points to the primary route (for speed on
--     indent order queries that filter by one route).
-- ════════════════════════════════════════════════════════════════════