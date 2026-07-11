-- ════════════════════════════════════════════════════════════════════
-- Haveri Milk Union — Order Route Snapshot + Cancel Window
-- 0040_orders_route_and_cancel_window.sql
--
-- • orders.route_id — the route this order belongs to, snapshotted at
--   confirm time. Needed so a later dealer route-switch doesn't move an
--   existing order, and so auto-confirm / cancel logic can find the
--   right close time.
-- • orders.cancel_window_ends_at — the deadline for free (no-approval)
--   self-cancellation. Set at confirm time to
--   min(confirmed_at + 30min, route close time).
--
-- orders is partitioned, so NO foreign keys (same reason dealer_id /
-- zone_id carry no FK).
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE orders ADD COLUMN IF NOT EXISTS route_id uuid;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancel_window_ends_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_orders_route ON orders (route_id)
  WHERE route_id IS NOT NULL;

-- Backfill route_id for existing non-cancelled orders from each dealer's
-- current primary route. Best-effort — orders predating routes stay NULL.
UPDATE orders o
SET route_id = d.route_id
FROM dealers d
WHERE o.dealer_id = d.id
  AND o.route_id IS NULL
  AND d.route_id IS NOT NULL;