-- ════════════════════════════════════════════════════════════════════
-- Haveri Milk Union — Per-Route Dealer Position
-- 0028_dealer_route_position.sql
--
-- Problem: dealers in a route are currently sorted by code/name on
-- both the Assign Route screen and the printed route sheet. The
-- delivery person actually drives a fixed geographic sequence, so
-- searching the sheet by name at every stop wastes time.
--
-- Solution: add a per-route `position` column to dealer_routes.
-- Same dealer on different routes can have different positions
-- (3rd stop on R1, 17th on R4). Backfill in current display order
-- using gaps of 10 so future inserts can slot in between without
-- renumbering everyone (e.g. insert at 25 between 20 and 30).
--
-- Idempotent — safe to re-run.
-- ════════════════════════════════════════════════════════════════════

-- ── 1. Column ──
-- Nullable on purpose: keeps the partial backfill below cheap, and
-- the query-side ORDER BY uses NULLS LAST so anything we miss still
-- renders in a sane place at the end of the list.
ALTER TABLE dealer_routes
  ADD COLUMN IF NOT EXISTS position integer;


-- ── 2. Backfill positions in current display order (per route) ──
-- ROW_NUMBER() * 10 gives 10, 20, 30… so reorders/inserts have
-- breathing room. Only fills NULLs — re-running won't clobber edits.
WITH ranked AS (
  SELECT dr.id,
         ROW_NUMBER() OVER (
           PARTITION BY dr.route_id
           ORDER BY d.code, d.name, dr.created_at
         ) * 10 AS pos
    FROM dealer_routes dr
    JOIN dealers d ON d.id = dr.dealer_id
   WHERE d.deleted_at IS NULL
     AND dr.position IS NULL
)
UPDATE dealer_routes dr
   SET position = ranked.pos
  FROM ranked
 WHERE dr.id = ranked.id;


-- ── 3. Default for future inserts where caller doesn't set one ──
-- Falls back to 9999 so newly-added dealers go to the end of the
-- list, where the API/UI auto-renumbering can pick them up.
ALTER TABLE dealer_routes
  ALTER COLUMN position SET DEFAULT 9999;


-- ── 4. Index for ORDER BY (route_id, position) ──
-- Route-sheet query and Assign Route list both filter by route_id
-- then ORDER BY position. A composite covers both.
CREATE INDEX IF NOT EXISTS idx_dealer_routes_route_position
  ON dealer_routes (route_id, position);


-- NOTE: deliberately NOT a UNIQUE constraint on (route_id, position).
-- Reorders that swap two rows would otherwise need a 3-step shuffle
-- through a temporary value. Ties are broken by (code, name) at query
-- time, which is good enough.

-- ════════════════════════════════════════════════════════════════════
-- Done. After this:
--   • Every existing dealer_routes row has a position (10, 20, 30…).
--   • New rows without an explicit position default to 9999 (end).
--   • API/UI can ORDER BY dr.position NULLS LAST, d.code, d.name.
-- ════════════════════════════════════════════════════════════════════
