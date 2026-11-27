-- ════════════════════════════════════════════════════════════════════
-- Haveri Milk Union — Admin notifications + product demand
-- 0086_admin_notifications_and_demand.sql
--
-- Why:
--   • The admin web's bell icon had nothing behind it.
--   • Dealers had no way to tell the union they want a product that is out
--     of stock in the app; that demand was invisible.
--   • Route officers' shortage entries reached the DTC bill silently.
--
-- What:
--   • admin_notifications       — one row per event, addressed to a set of
--                                 staff roles (roles text[]). The bell shows
--                                 the latest for the viewer's role.
--   • admin_notification_reads  — per user read marks.
--   • product_demand_requests   — a dealer's "Notify" on an out-of-stock
--                                 product: one per dealer, product and IST
--                                 day (a second tap that day is the same
--                                 request). resolved_at once staff have
--                                 dealt with it.
--
-- Idempotent.
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS admin_notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 'product_demand' | 'officer_shortage' | …
  kind        text NOT NULL,
  title       text NOT NULL,
  body        text,
  -- Web path to open, e.g. '/sales/product-demand'
  link        text,
  -- Staff roles who see it (super_admin always does)
  roles       text[] NOT NULL DEFAULT '{}',
  ref_id      uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_admin_notifications_created ON admin_notifications (created_at DESC);

CREATE TABLE IF NOT EXISTS admin_notification_reads (
  notification_id uuid NOT NULL REFERENCES admin_notifications(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (notification_id, user_id)
);

CREATE TABLE IF NOT EXISTS product_demand_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dealer_id    uuid NOT NULL REFERENCES dealers(id) ON DELETE CASCADE,
  product_id   uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  -- IST calendar day of the request (one request per dealer/product/day)
  request_date date NOT NULL,
  -- Taps that day (a dealer pressing again shows the need is still there)
  taps         int NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz,
  resolved_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (dealer_id, product_id, request_date)
);
CREATE INDEX IF NOT EXISTS idx_product_demand_date ON product_demand_requests (request_date DESC);
CREATE INDEX IF NOT EXISTS idx_product_demand_product ON product_demand_requests (product_id, request_date);
