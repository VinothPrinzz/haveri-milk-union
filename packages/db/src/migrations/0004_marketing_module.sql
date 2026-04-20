-- ══════════════════════════════════════════════════════════════════
-- Haveri Milk Union — Marketing Module Migration
-- 0004_marketing_module.sql
--
-- Phase 2 of the Complete Build Plan. Adds:
--   1. New enum value: 'officer' added to user_role
--   2. New enums: batch_status, direct_sale_customer_type, route_sheet_status
--   3. New tables: contractors, batches, rate_categories, price_chart,
--      cash_customers, direct_sales, direct_sale_items, route_sheets,
--      gate_pass_items
--   4. ALTER TABLE changes: routes (contractor_id), fgs_stock_log (batch_id),
--      orders (officer_id)
--   5. Indexes on all new tables
--   6. updated_at triggers on mutable tables
--   7. Seed data for rate categories
--
-- Run with: psql $DATABASE_URL -f 0004_marketing_module.sql
-- Or via Drizzle: pnpm db:migrate
-- ══════════════════════════════════════════════════════════════════


-- ┌─────────────────────────────────────────┐
-- │       EXTEND EXISTING ENUMS              │
-- └─────────────────────────────────────────┘

-- Add 'officer' role for sales officers who handle direct sales / gate passes.
-- ALTER TYPE ... ADD VALUE is not transactional in PG < 12, but is safe in PG 12+.
-- Supabase runs PG 15, so this is fine.
DO $$ BEGIN
  ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'officer';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ┌─────────────────────────────────────────┐
-- │       NEW ENUM TYPES                     │
-- └─────────────────────────────────────────┘

DO $$ BEGIN
  CREATE TYPE batch_status AS ENUM ('active', 'closed', 'expired');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE direct_sale_customer_type AS ENUM ('agent', 'cash');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE route_sheet_status AS ENUM ('draft', 'confirmed', 'dispatched', 'completed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Extend payment_mode to include 'cash' for direct/walk-in sales.
DO $$ BEGIN
  ALTER TYPE payment_mode ADD VALUE IF NOT EXISTS 'cash';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ┌─────────────────────────────────────────┐
-- │       NEW TABLES                         │
-- └─────────────────────────────────────────┘

-- ── Contractors ──
-- Milk collection agents / transport contractors distinct from dealer-customers.
-- Each contractor may be assigned to one or more routes.
-- The route table gets a contractor_id FK (added via ALTER below).
CREATE TABLE IF NOT EXISTS contractors (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  phone           text NOT NULL,
  zone_id         uuid REFERENCES zones(id) ON DELETE SET NULL,
  address         text,
  vehicle_number  text,                     -- primary vehicle
  license_number  text,                     -- transport license
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz               -- soft delete
);
CREATE INDEX IF NOT EXISTS idx_contractors_zone ON contractors (zone_id)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_contractors_active ON contractors (active)
  WHERE deleted_at IS NULL;


-- ── Batches (Distribution Batches) ──
-- Production/distribution batches that link FGS stock entries to a batch.
-- e.g. "Morning Batch", "Afternoon Batch", "Evening Batch"
-- NOT the same as product manufacturing batches — these are delivery schedule batches.
CREATE TABLE IF NOT EXISTS batches (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_number      text NOT NULL UNIQUE,    -- e.g. "BT01", "BT02"
  name              text NOT NULL,           -- e.g. "Morning Batch"
  which_batch       text NOT NULL,           -- "Morning", "Afternoon", "Evening", "Night"
  timing            text,                    -- "5:00 AM - 8:00 AM"
  status            batch_status NOT NULL DEFAULT 'active',
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz              -- soft delete
);
CREATE INDEX IF NOT EXISTS idx_batches_status ON batches (status)
  WHERE deleted_at IS NULL;


-- ── Batch Routes (many-to-many: batches ↔ routes) ──
-- A batch can serve multiple routes; a route can be served by multiple batches.
CREATE TABLE IF NOT EXISTS batch_routes (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id  uuid NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  route_id  uuid NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  UNIQUE (batch_id, route_id)
);
CREATE INDEX IF NOT EXISTS idx_batch_routes_batch ON batch_routes (batch_id);
CREATE INDEX IF NOT EXISTS idx_batch_routes_route ON batch_routes (route_id);


-- ── Rate Categories ──
-- Used by Price Chart: "Retail-Dealer", "Credit Inst-MRP",
-- "Credit Inst-Dealer", "Parlour-Dealer"
CREATE TABLE IF NOT EXISTS rate_categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  description text,
  sort_order  integer NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);


-- ── Price Chart ──
-- Per-product, per-rate-category pricing. Separate from the base product price.
-- Supports effective date ranges for scheduled price changes.
-- If effective_to IS NULL, the price is currently active (open-ended).
CREATE TABLE IF NOT EXISTS price_chart (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id        uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  rate_category_id  uuid NOT NULL REFERENCES rate_categories(id) ON DELETE RESTRICT,
  price             numeric(10, 2) NOT NULL,
  effective_from    date NOT NULL,
  effective_to      date,                    -- NULL = currently active
  created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_price_chart_product ON price_chart (product_id);
CREATE INDEX IF NOT EXISTS idx_price_chart_category ON price_chart (rate_category_id);
-- Composite index for "current price lookup": find the active price for a product + category
CREATE INDEX IF NOT EXISTS idx_price_chart_active_lookup
  ON price_chart (product_id, rate_category_id, effective_from DESC)
  WHERE effective_to IS NULL;


-- ── Cash Customers ──
-- Walk-in cash buyers for direct sales (not registered dealers).
-- Minimal info — name and phone are enough for a receipt.
CREATE TABLE IF NOT EXISTS cash_customers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  phone      text,
  address    text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz                    -- soft delete
);
CREATE INDEX IF NOT EXISTS idx_cash_customers_phone ON cash_customers (phone)
  WHERE deleted_at IS NULL AND phone IS NOT NULL;


-- ── Direct Sales ──
-- Gate pass (agent) and cash customer sales.
-- These are NOT dealer indents — they go through a different workflow.
-- customer_type determines whether customer_id references dealers (agent) or cash_customers (cash).
CREATE TABLE IF NOT EXISTS direct_sales (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_type  direct_sale_customer_type NOT NULL,
  customer_id    uuid NOT NULL,              -- references dealers.id or cash_customers.id (polymorphic)
  route_id       uuid REFERENCES routes(id) ON DELETE SET NULL,
  officer_id     uuid REFERENCES users(id) ON DELETE SET NULL,  -- sales officer who processed this
  batch_id       uuid REFERENCES batches(id) ON DELETE SET NULL,
  sale_date      date NOT NULL,
  payment_mode   payment_mode NOT NULL DEFAULT 'cash',
  payment_ref    text,                       -- UPI ref or receipt number
  subtotal       numeric(10, 2) NOT NULL,
  total_gst      numeric(10, 2) NOT NULL DEFAULT 0,
  grand_total    numeric(10, 2) NOT NULL,
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_direct_sales_customer ON direct_sales (customer_type, customer_id);
CREATE INDEX IF NOT EXISTS idx_direct_sales_date ON direct_sales (sale_date DESC);
CREATE INDEX IF NOT EXISTS idx_direct_sales_route ON direct_sales (route_id);
CREATE INDEX IF NOT EXISTS idx_direct_sales_officer ON direct_sales (officer_id);
CREATE INDEX IF NOT EXISTS idx_direct_sales_batch ON direct_sales (batch_id);


-- ── Direct Sale Items ──
-- Line items for a direct sale. Same pattern as order_items.
-- Stores snapshot of price at time of sale.
CREATE TABLE IF NOT EXISTS direct_sale_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  direct_sale_id  uuid NOT NULL REFERENCES direct_sales(id) ON DELETE CASCADE,
  product_id      uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  product_name    text NOT NULL,             -- snapshot: product name at sale time
  quantity        integer NOT NULL,
  unit_price      numeric(10, 2) NOT NULL,   -- snapshot: price at sale time
  gst_percent     numeric(5, 2) NOT NULL DEFAULT 0,
  gst_amount      numeric(10, 2) NOT NULL DEFAULT 0,
  line_total      numeric(10, 2) NOT NULL,   -- (unit_price * quantity) + gst_amount
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_direct_sale_items_sale ON direct_sale_items (direct_sale_id);
CREATE INDEX IF NOT EXISTS idx_direct_sale_items_product ON direct_sale_items (product_id);


-- ── Gate Pass Items ──
-- Tracks issued vs returned quantities for agent gate passes.
-- A gate pass is a direct_sale where customer_type = 'agent'.
-- returned_quantity is updated when the agent returns unsold stock.
CREATE TABLE IF NOT EXISTS gate_pass_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  direct_sale_id     uuid NOT NULL REFERENCES direct_sales(id) ON DELETE CASCADE,
  product_id         uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  quantity           integer NOT NULL,        -- issued quantity
  returned_quantity  integer NOT NULL DEFAULT 0,  -- returned unsold
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gate_pass_items_sale ON gate_pass_items (direct_sale_id);
CREATE INDEX IF NOT EXISTS idx_gate_pass_items_product ON gate_pass_items (product_id);


-- ── Route Sheets ──
-- Formal daily route sheet records — generated when indents are "posted" for a route.
-- One route sheet per route per date per batch.
CREATE TABLE IF NOT EXISTS route_sheets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id        uuid NOT NULL REFERENCES routes(id) ON DELETE RESTRICT,
  batch_id        uuid REFERENCES batches(id) ON DELETE SET NULL,
  date            date NOT NULL,
  vehicle_number  text,
  driver_name     text,
  contractor_id   uuid REFERENCES contractors(id) ON DELETE SET NULL,
  departure_time  time,
  arrival_time    time,
  total_crates    integer NOT NULL DEFAULT 0,
  total_amount    numeric(12, 2) NOT NULL DEFAULT 0,
  dealer_count    integer NOT NULL DEFAULT 0,
  status          route_sheet_status NOT NULL DEFAULT 'draft',
  notes           text,
  generated_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_route_sheets_route_date_batch
  ON route_sheets (route_id, date, batch_id)
  WHERE batch_id IS NOT NULL;
-- Separate unique index for when batch_id is NULL (all batches)
CREATE UNIQUE INDEX IF NOT EXISTS uq_route_sheets_route_date_nobatch
  ON route_sheets (route_id, date)
  WHERE batch_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_route_sheets_date ON route_sheets (date DESC);
CREATE INDEX IF NOT EXISTS idx_route_sheets_route ON route_sheets (route_id);
CREATE INDEX IF NOT EXISTS idx_route_sheets_status ON route_sheets (status);


-- ┌─────────────────────────────────────────┐
-- │       ALTER EXISTING TABLES               │
-- └─────────────────────────────────────────┘

-- Link routes to contractors.
-- A route can optionally be assigned a default contractor.
ALTER TABLE routes
  ADD COLUMN IF NOT EXISTS contractor_id uuid REFERENCES contractors(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_routes_contractor ON routes (contractor_id)
  WHERE contractor_id IS NOT NULL;

-- Link FGS stock log entries to a specific batch.
ALTER TABLE fgs_stock_log
  ADD COLUMN IF NOT EXISTS batch_id uuid REFERENCES batches(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_fgs_stock_batch ON fgs_stock_log (batch_id)
  WHERE batch_id IS NOT NULL;

-- Track which officer (sales officer / call desk) placed an order on behalf of dealer.
-- orders.placed_by already exists from 0001, but let's add officer_id for the
-- specific sales officer role (distinct from the admin who placed via call desk).
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS officer_id uuid;
-- No FK on partitioned table (same reason as dealer_id/zone_id).
CREATE INDEX IF NOT EXISTS idx_orders_officer ON orders (officer_id)
  WHERE officer_id IS NOT NULL;


-- ┌─────────────────────────────────────────┐
-- │       updated_at TRIGGERS                 │
-- └─────────────────────────────────────────┘
-- Using the set_updated_at() function created in 0001.
-- Applied to all new mutable tables.
-- NOT applied to: direct_sale_items (append-only like order_items).

CREATE TRIGGER trg_contractors_updated_at BEFORE UPDATE ON contractors
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_batches_updated_at BEFORE UPDATE ON batches
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_rate_categories_updated_at BEFORE UPDATE ON rate_categories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_price_chart_updated_at BEFORE UPDATE ON price_chart
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_cash_customers_updated_at BEFORE UPDATE ON cash_customers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_direct_sales_updated_at BEFORE UPDATE ON direct_sales
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_gate_pass_items_updated_at BEFORE UPDATE ON gate_pass_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_route_sheets_updated_at BEFORE UPDATE ON route_sheets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ┌─────────────────────────────────────────┐
-- │       SEED DATA                           │
-- └─────────────────────────────────────────┘

-- ── Rate Categories (from Lovable mockData) ──
INSERT INTO rate_categories (name, description, sort_order) VALUES
  ('Retail-Dealer',        'Standard retail dealer rates',            1),
  ('Credit Inst-MRP',      'Credit institution at MRP pricing',      2),
  ('Credit Inst-Dealer',   'Credit institution at dealer pricing',   3),
  ('Parlour-Dealer',       'Parlour / restaurant dealer rates',      4)
ON CONFLICT (name) DO NOTHING;

-- ── Default Batches (from Lovable mockData) ──
INSERT INTO batches (batch_number, name, which_batch, timing) VALUES
  ('BT01', 'Morning Batch',   'Morning',   '5:00 AM - 8:00 AM'),
  ('BT02', 'Afternoon Batch', 'Afternoon', '12:00 PM - 2:00 PM'),
  ('BT03', 'Evening Batch',   'Evening',   '4:00 PM - 6:00 PM')
ON CONFLICT (batch_number) DO NOTHING;

-- ── Seed price chart: set all existing products at base_price for all rate categories ──
-- This gives every product a starting price in every rate category.
INSERT INTO price_chart (product_id, rate_category_id, price, effective_from)
SELECT p.id, rc.id, p.base_price, '2025-01-01'::date
FROM products p
CROSS JOIN rate_categories rc
WHERE p.deleted_at IS NULL
ON CONFLICT DO NOTHING;

-- ── Sample Contractors (from Lovable mockData) ──
INSERT INTO contractors (name, phone, address, vehicle_number, active)
VALUES
  ('Karnataka Transport Co.',  '9876500001', 'Industrial Area, Haveri',      'KA-25-AB-1234', true),
  ('Sree Logistics',           '9876500002', 'NH-4 Highway, Haveri',         'KA-25-CD-5678', true),
  ('Raghavendra Transports',   '9876500003', 'Station Road, Ranebennur',     'KA-25-EF-9012', false)
ON CONFLICT DO NOTHING;

-- ── Link routes to contractors (if routes already exist from previous seeds) ──
-- Route 1 & 2 → Karnataka Transport Co.
-- Route 3 & 4 → Sree Logistics
-- Route 5 & 6 → Raghavendra Transports
DO $$
DECLARE
  v_ct1 uuid;
  v_ct2 uuid;
  v_ct3 uuid;
BEGIN
  SELECT id INTO v_ct1 FROM contractors WHERE phone = '9876500001' LIMIT 1;
  SELECT id INTO v_ct2 FROM contractors WHERE phone = '9876500002' LIMIT 1;
  SELECT id INTO v_ct3 FROM contractors WHERE phone = '9876500003' LIMIT 1;

  IF v_ct1 IS NOT NULL THEN
    UPDATE routes SET contractor_id = v_ct1 WHERE code IN ('R1', 'R2') AND contractor_id IS NULL;
  END IF;
  IF v_ct2 IS NOT NULL THEN
    UPDATE routes SET contractor_id = v_ct2 WHERE code IN ('R3', 'R4') AND contractor_id IS NULL;
  END IF;
  IF v_ct3 IS NOT NULL THEN
    UPDATE routes SET contractor_id = v_ct3 WHERE code IN ('R5', 'R6') AND contractor_id IS NULL;
  END IF;
END $$;

-- ── Link batches to routes ──
DO $$
DECLARE
  v_bt1 uuid;
  v_bt2 uuid;
  v_bt3 uuid;
  v_r1 uuid; v_r2 uuid; v_r3 uuid; v_r4 uuid; v_r5 uuid; v_r6 uuid;
BEGIN
  SELECT id INTO v_bt1 FROM batches WHERE batch_number = 'BT01';
  SELECT id INTO v_bt2 FROM batches WHERE batch_number = 'BT02';
  SELECT id INTO v_bt3 FROM batches WHERE batch_number = 'BT03';

  SELECT id INTO v_r1 FROM routes WHERE code = 'R1';
  SELECT id INTO v_r2 FROM routes WHERE code = 'R2';
  SELECT id INTO v_r3 FROM routes WHERE code = 'R3';
  SELECT id INTO v_r4 FROM routes WHERE code = 'R4';
  SELECT id INTO v_r5 FROM routes WHERE code = 'R5';
  SELECT id INTO v_r6 FROM routes WHERE code = 'R6';

  -- Morning batch: R1, R2, R3, R4
  IF v_bt1 IS NOT NULL THEN
    INSERT INTO batch_routes (batch_id, route_id)
    VALUES (v_bt1, v_r1), (v_bt1, v_r2), (v_bt1, v_r3), (v_bt1, v_r4)
    ON CONFLICT (batch_id, route_id) DO NOTHING;
  END IF;

  -- Afternoon batch: R2, R5
  IF v_bt2 IS NOT NULL THEN
    INSERT INTO batch_routes (batch_id, route_id)
    VALUES (v_bt2, v_r2), (v_bt2, v_r5)
    ON CONFLICT (batch_id, route_id) DO NOTHING;
  END IF;

  -- Evening batch: R1, R6
  IF v_bt3 IS NOT NULL THEN
    INSERT INTO batch_routes (batch_id, route_id)
    VALUES (v_bt3, v_r1), (v_bt3, v_r6)
    ON CONFLICT (batch_id, route_id) DO NOTHING;
  END IF;
END $$;


-- ┌─────────────────────────────────────────┐
-- │           DONE                           │
-- └─────────────────────────────────────────┘
-- Migration 0004 complete. Added:
-- ✓ Extended user_role enum with 'officer'
-- ✓ Extended payment_mode enum with 'cash'
-- ✓ New enums: batch_status, direct_sale_customer_type, route_sheet_status
-- ✓ New tables: contractors, batches, batch_routes, rate_categories, price_chart,
--   cash_customers, direct_sales, direct_sale_items, gate_pass_items, route_sheets
-- ✓ ALTER TABLE: routes (contractor_id), fgs_stock_log (batch_id), orders (officer_id)
-- ✓ Indexes on all new tables including partial indexes
-- ✓ updated_at triggers on all mutable new tables
-- ✓ Seed data: rate categories, batches, sample contractors, batch↔route links, price chart
