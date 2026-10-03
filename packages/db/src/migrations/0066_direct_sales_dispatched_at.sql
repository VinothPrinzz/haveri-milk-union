-- ════════════════════════════════════════════════════════════════════
-- 0066 — Adhoc sales can be marked dispatched
--
-- The Dispatch Sheet buckets route-less counter sales (cash / VIP sample /
-- employee subsidy) under an ADHOC sentinel card. The goods are real and
-- they are loaded off the same FGS floor as every route, but the card had
-- no "Mark Dispatched" action: route dispatch state lives in
-- route_assignments, whose route_id is a FK to routes, and the sentinel is
-- not a real route. So the loader could tick the checklist and then had no
-- way to close it out, and nothing recorded that the goods had left.
--
-- direct_sales carries no status column at all (a counter sale is booked
-- once, complete), so this adds the one field that was missing: WHEN the
-- goods physically went out. NULL = still on the floor.
--
-- Why a per-sale stamp rather than one assignment row for the bucket:
-- counter sales keep arriving through the day. With a per-row stamp, a
-- sale booked after the loader closed the bucket correctly re-opens it
-- (new goods to load) instead of hiding behind an already-dispatched
-- header. It also gives the actual departure time per sale, which the
-- single-row alternative cannot.
--
-- Routed adhoc sales get stamped too, by the same cascade that dispatches
-- their route — they ride that truck, so they leave when it does.
--
-- Pure additive DDL: one nullable column plus a partial index. Existing
-- rows stay NULL, which reads as "never dispatched" — correct for history,
-- since before today nothing tracked this at all.
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE direct_sales
  ADD COLUMN IF NOT EXISTS dispatched_at timestamptz;

-- The dispatch sheet asks "which of today's adhoc sales are still waiting
-- to load", i.e. sale_date = today AND dispatched_at IS NULL. Partial on
-- the NULL side keeps the index tiny: rows drop out of it as they are
-- dispatched, so it only ever holds the open ones.
CREATE INDEX IF NOT EXISTS idx_direct_sales_undispatched
  ON direct_sales (sale_date)
  WHERE dispatched_at IS NULL;
