-- ════════════════════════════════════════════════════════════════════
-- Haveri Milk Union — Admin Panel Fixes Migration
-- 0009_admin_panel_fixes.sql
--
-- Adds:
--   • contractors.code              (Issue #1)
--   • products.{retail_dealer_price, credit_inst_mrp_price,
--               credit_inst_dealer_price, parlour_dealer_price}  (Issue #6)
--   • notification_config.description (Issue #17)
--   • direct_sales.gp_no             (Issue #12)
--
-- All ALTERs are idempotent (IF NOT EXISTS).
-- ════════════════════════════════════════════════════════════════════

-- ── 1. Contractor code (Issue #1) ─────────────────────────────────
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS code text;
CREATE UNIQUE INDEX IF NOT EXISTS uq_contractors_code
  ON contractors (code) WHERE code IS NOT NULL AND deleted_at IS NULL;

-- Seed CTR-XXXX codes for any existing contractors without one.
DO $$
DECLARE
  rec RECORD;
  counter INT := 1;
BEGIN
  FOR rec IN
    SELECT id FROM contractors
    WHERE deleted_at IS NULL AND code IS NULL
    ORDER BY created_at, name
  LOOP
    UPDATE contractors
    SET code = 'CTR-' || LPAD(counter::text, 4, '0')
    WHERE id = rec.id;
    counter := counter + 1;
  END LOOP;
END $$;


-- ── 2. Per-rate-category prices on products (Issue #6) ────────────
-- NULL means "use base_price" — the API COALESCEs to base_price on read.
ALTER TABLE products ADD COLUMN IF NOT EXISTS retail_dealer_price       numeric(10, 2);
ALTER TABLE products ADD COLUMN IF NOT EXISTS credit_inst_mrp_price     numeric(10, 2);
ALTER TABLE products ADD COLUMN IF NOT EXISTS credit_inst_dealer_price  numeric(10, 2);
ALTER TABLE products ADD COLUMN IF NOT EXISTS parlour_dealer_price      numeric(10, 2);

-- Seed all four columns from base_price for existing products,
-- so the chart immediately shows MRP everywhere on first load.
UPDATE products
SET retail_dealer_price      = COALESCE(retail_dealer_price,      base_price),
    credit_inst_mrp_price    = COALESCE(credit_inst_mrp_price,    base_price),
    credit_inst_dealer_price = COALESCE(credit_inst_dealer_price, base_price),
    parlour_dealer_price     = COALESCE(parlour_dealer_price,     base_price)
WHERE deleted_at IS NULL;


-- ── 3. Notification config description (Issue #17) ────────────────
ALTER TABLE notification_config ADD COLUMN IF NOT EXISTS description text;

-- Seed sensible defaults from event_name. Admin can edit later.
UPDATE notification_config SET description = CASE event_name
  WHEN 'order.placed'      THEN 'Sent when a dealer places a new order'
  WHEN 'order.confirmed'   THEN 'Sent when an order is posted for dispatch'
  WHEN 'order.dispatched'  THEN 'Sent when an order leaves the depot'
  WHEN 'order.delivered'   THEN 'Sent when an order reaches the dealer'
  WHEN 'order.cancelled'   THEN 'Sent when an order is cancelled'
  WHEN 'window.opening'    THEN 'Sent 5 minutes before the ordering window opens'
  WHEN 'window.closing'    THEN 'Sent 15 minutes before the ordering window closes'
  WHEN 'payment.reminder'  THEN 'Sent for credit dealers with overdue balance'
  WHEN 'wallet.lowbalance' THEN 'Sent when dealer wallet drops below threshold'
  ELSE INITCAP(REPLACE(event_name, '.', ' '))
END
WHERE description IS NULL;


-- ── 4. Direct-sales gate pass number (Issue #12) ──────────────────
-- Sequential, human-readable: GP-0001, GP-0002, ...
CREATE SEQUENCE IF NOT EXISTS gp_no_seq START 1;

ALTER TABLE direct_sales ADD COLUMN IF NOT EXISTS gp_no text;

-- Backfill existing rows.
UPDATE direct_sales
SET gp_no = 'GP-' || LPAD(nextval('gp_no_seq')::text, 4, '0')
WHERE gp_no IS NULL;

-- Going forward, set default for new rows.
ALTER TABLE direct_sales
  ALTER COLUMN gp_no SET DEFAULT ('GP-' || LPAD(nextval('gp_no_seq')::text, 4, '0'));

CREATE UNIQUE INDEX IF NOT EXISTS uq_direct_sales_gp_no
  ON direct_sales (gp_no);


-- ── 5. Helpful index for Post Indent server-side filter (Issue #9) ─
-- Filter is (status='pending', dealer→route, created_at::date), so an
-- index that supports the partial query plan helps at 100+ dealers/day.
CREATE INDEX IF NOT EXISTS idx_dealers_route ON dealers (route_id)
  WHERE deleted_at IS NULL;

-- ════════════════════════════════════════════════════════════════════
-- Done.
-- ════════════════════════════════════════════════════════════════════