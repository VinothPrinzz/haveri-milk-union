-- ════════════════════════════════════════════════════════════════════
-- Haveri Milk Union — Per-route standing indents
-- 0061_per_route_standing_indents.sql
--
-- Before: dealer_standing_indents is UNIQUE (dealer_id, product_id) — one
-- template per dealer. A dealer on two routes therefore shares a single
-- template, so editing "route A's indent" changes route B too.
--
-- After: the template is per (dealer, route). A dealer on routes A and B can
-- carry different standing quantities for each, and each route materialises
-- into its OWN order for the day (so a two-route dealer gets two deliveries).
--
-- This also relaxes the "one live order per (dealer, delivery_date)" rule to
-- "one live order per (dealer, ROUTE, delivery_date)". The DB never actually
-- enforced the old rule across partitions (orders is partitioned by
-- created_at, and Postgres won't enforce a unique index that omits the
-- partition key) — the authoritative gate is the application-level
-- cancelSupersededSiblings, which this migration's code companion scopes to
-- per-route. Here we only DROP the leftover per-day unique index so it can't
-- reject a second same-day order on a different route.
--
-- Apply MANUALLY on prod (the migration runner is off there — the _migrations
-- table is stale). Idempotent; safe to re-run.
-- ════════════════════════════════════════════════════════════════════

-- ── 1. dealer_standing_indents: add the route dimension ──────────────
ALTER TABLE dealer_standing_indents
  ADD COLUMN IF NOT EXISTS route_id uuid;

-- Backfill existing single-template rows onto each dealer's primary route
-- (dealers.route_id). Rows for a dealer with no route stay NULL — they were
-- unusable anyway (a routeless dealer can't order) and never match a
-- route-scoped query.
UPDATE dealer_standing_indents dsi
   SET route_id = d.route_id
  FROM dealers d
 WHERE dsi.dealer_id = d.id
   AND dsi.route_id IS NULL
   AND d.route_id IS NOT NULL;

-- Swap the uniqueness from (dealer, product) to (dealer, route, product).
-- Every write path infers ON CONFLICT from this index, so it must exist
-- before the new API code runs. No duplicate (dealer, route, product) rows
-- can exist post-backfill (the old key guaranteed ≤1 row per (dealer,
-- product), and all got the same primary route), so the CREATE won't fail.
DROP INDEX IF EXISTS uq_dealer_standing_indents_dealer_product;
CREATE UNIQUE INDEX IF NOT EXISTS uq_dealer_standing_indents_dealer_route_product
  ON dealer_standing_indents (dealer_id, route_id, product_id);

-- Materialiser fetch is now per (dealer, route).
CREATE INDEX IF NOT EXISTS idx_dealer_standing_indents_route_active
  ON dealer_standing_indents (dealer_id, route_id)
  WHERE active = true AND default_qty > 0;

-- ── 2. Relax the one-order-per-day gate to per-route ─────────────────
-- Drop the leftover per-day unique index so a dealer can hold two live
-- orders on the same date (one per route). The per-route supersede in the
-- application code is the real enforcement.
--
-- NOTE: if this index was ever materialised per-partition (a local index on
-- each orders_YYYY_MM), those locals must be dropped too. Find them with:
--   SELECT indexrelid::regclass
--     FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid
--    WHERE c.relname LIKE 'orders_%'
--      AND pg_get_indexdef(i.indexrelid) ILIKE '%dealer_id%delivery_date%'
--      AND indisunique;
DROP INDEX IF EXISTS uq_orders_dealer_delivery_active;

-- ════════════════════════════════════════════════════════════════════
-- Done. After this + the code companion:
--   • dealer_standing_indents holds one template per (dealer, route).
--   • materialize-drafts builds one draft per (dealer, route, date).
--   • auto-confirm confirms each route's draft at that route's close time.
--   • cancelSupersededSiblings only cancels same-route siblings.
--   • Dealer app endpoints scope to the dealer's active route (no app change).
-- ════════════════════════════════════════════════════════════════════
