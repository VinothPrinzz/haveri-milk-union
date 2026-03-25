-- ══════════════════════════════════════════════════════════════════
-- Haveri Milk Union — Initial Schema Migration
-- 0001_initial_schema.sql
--
-- IMPORTANT: This migration is hand-written (not Drizzle-generated)
-- because it contains:
--   1. Partitioned orders table (Drizzle can't generate this)
--   2. Partial indexes
--   3. Custom helper functions
--   4. Seed data for zones and categories
--
-- Run with: psql $DATABASE_URL -f 0001_initial_schema.sql
-- Or via Drizzle: pnpm db:migrate
-- ══════════════════════════════════════════════════════════════════

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ┌─────────────────────────────────────────┐
-- │           ENUM TYPES                     │
-- └─────────────────────────────────────────┘

DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('super_admin', 'manager', 'dispatch_officer', 'accountant', 'call_desk');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE order_status AS ENUM ('pending', 'confirmed', 'dispatched', 'delivered', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE payment_mode AS ENUM ('wallet', 'upi', 'credit');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE cancellation_status AS ENUM ('pending', 'approved', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE ledger_type AS ENUM ('credit', 'debit');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE ledger_ref_type AS ENUM ('wallet_topup', 'order', 'refund', 'adjustment');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE registration_status AS ENUM ('pending', 'approved', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE approval_type AS ENUM ('new_registration', 'credit_limit_increase', 'address_change', 'gst_update');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE dispatch_status AS ENUM ('pending', 'loading', 'dispatched', 'delivered');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE delivery_status AS ENUM ('queued', 'sent', 'delivered', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE notif_channel AS ENUM ('push', 'sms', 'email');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE settlement_status AS ENUM ('pending', 'processed', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ┌─────────────────────────────────────────┐
-- │           CORE TABLES                    │
-- └─────────────────────────────────────────┘

-- ── Zones ──
CREATE TABLE IF NOT EXISTS zones (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  slug        text NOT NULL UNIQUE,
  icon        text,
  color       text,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ── Time Windows ──
CREATE TABLE IF NOT EXISTS time_windows (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  zone_id         uuid NOT NULL UNIQUE REFERENCES zones(id) ON DELETE RESTRICT,
  open_time       time NOT NULL,
  warning_minutes integer NOT NULL DEFAULT 20,
  close_time      time NOT NULL,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ── Categories ──
CREATE TABLE IF NOT EXISTS categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  icon        text,
  sort_order  integer NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);

-- ── Products ──
CREATE TABLE IF NOT EXISTS products (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                     text NOT NULL,
  category_id              uuid NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
  icon                     text,
  unit                     text NOT NULL,
  base_price               numeric(10, 2) NOT NULL,
  gst_percent              numeric(5, 2) NOT NULL,
  stock                    integer NOT NULL DEFAULT 0,
  low_stock_threshold      integer NOT NULL DEFAULT 50,
  critical_stock_threshold integer NOT NULL DEFAULT 10,
  available                boolean NOT NULL DEFAULT true,
  sort_order               integer NOT NULL DEFAULT 0,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  deleted_at               timestamptz
);

-- ── Price Revisions ──
CREATE TABLE IF NOT EXISTS price_revisions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id      uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  old_price       numeric(10, 2) NOT NULL,
  new_price       numeric(10, 2) NOT NULL,
  old_gst_percent numeric(5, 2) NOT NULL,
  new_gst_percent numeric(5, 2) NOT NULL,
  effective_from  date NOT NULL,
  changed_by      uuid NOT NULL,
  reason          text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ── Admin Users ──
CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  email         text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role          user_role NOT NULL,
  zone_id       uuid REFERENCES zones(id) ON DELETE SET NULL,
  phone         text,
  active        boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);

-- ── Admin Sessions (server-side, revocable) ──
CREATE TABLE IF NOT EXISTS admin_sessions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      text NOT NULL UNIQUE,
  ip_address text,
  user_agent text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ── Dealers ──
CREATE TABLE IF NOT EXISTS dealers (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text NOT NULL,
  phone                 text NOT NULL UNIQUE,
  email                 text,
  gst_number            text,
  zone_id               uuid NOT NULL REFERENCES zones(id) ON DELETE RESTRICT,
  address               text,
  city                  text,
  pin_code              text,
  location_label        text,
  contact_person        text,
  credit_limit          numeric(10, 2) NOT NULL DEFAULT 0,
  fcm_token             text,
  language_preference   text NOT NULL DEFAULT 'en',
  biometric_enabled     boolean NOT NULL DEFAULT false,
  notifications_enabled boolean NOT NULL DEFAULT true,
  active                boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  deleted_at            timestamptz
);

-- ── Dealer Wallets ──
-- CRITICAL: Wallet deduction is atomic:
--   UPDATE dealer_wallets SET balance = balance - $1
--   WHERE dealer_id = $2 AND balance >= $1 RETURNING balance;
-- Row-level locking handles concurrent deductions automatically.
CREATE TABLE IF NOT EXISTS dealer_wallets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dealer_id       uuid NOT NULL UNIQUE REFERENCES dealers(id) ON DELETE RESTRICT,
  balance         numeric(12, 2) NOT NULL DEFAULT 0,
  last_topup_at   timestamptz,
  last_topup_amount numeric(10, 2),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ── Dealer OTPs ──
CREATE TABLE IF NOT EXISTS dealer_otps (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone      text NOT NULL,
  otp        text NOT NULL,
  expires_at timestamptz NOT NULL,
  verified   boolean NOT NULL DEFAULT false,
  attempts   integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ── Dealer Refresh Tokens ──
CREATE TABLE IF NOT EXISTS dealer_refresh_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dealer_id  uuid NOT NULL REFERENCES dealers(id) ON DELETE CASCADE,
  token      text NOT NULL UNIQUE,
  family     text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dealer_refresh_tokens_dealer ON dealer_refresh_tokens (dealer_id);
CREATE INDEX IF NOT EXISTS idx_dealer_refresh_tokens_family ON dealer_refresh_tokens (family);

-- ── Approval Requests ──
CREATE TABLE IF NOT EXISTS approval_requests (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dealer_id      uuid REFERENCES dealers(id) ON DELETE SET NULL,
  type           approval_type NOT NULL,
  status         registration_status NOT NULL DEFAULT 'pending',
  submitted_data text NOT NULL,
  reviewed_by    uuid,
  review_note    text,
  reviewed_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);


-- ┌─────────────────────────────────────────┐
-- │   ORDERS TABLE — PARTITIONED BY MONTH   │
-- │   This is the most critical DDL.        │
-- └─────────────────────────────────────────┘

-- The orders table MUST be partitioned from day one.
-- Retroactive partitioning on a live table is a multi-hour maintenance window.
-- Monthly partitions keep report queries fast — they scan only the relevant month.

CREATE TABLE IF NOT EXISTS orders (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  dealer_id           uuid NOT NULL,
  zone_id             uuid NOT NULL,
  status              order_status NOT NULL DEFAULT 'pending',
  payment_mode        payment_mode NOT NULL DEFAULT 'wallet',
  payment_reference   text,
  subtotal            numeric(10, 2) NOT NULL,
  total_gst           numeric(10, 2) NOT NULL,
  grand_total         numeric(10, 2) NOT NULL,
  item_count          integer NOT NULL DEFAULT 0,
  notes               text,
  placed_by           uuid,
  confirmed_at        timestamptz,
  dispatched_at       timestamptz,
  delivered_at        timestamptz,
  cancelled_at        timestamptz,
  cancellation_reason text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  -- Composite primary key required for partitioned tables.
  -- Partition key (created_at) must be part of the PK.
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Create partitions for 2025 and 2026 (covers the first 2 years).
-- BullMQ job creates future partitions on the 25th of each month.
CREATE TABLE IF NOT EXISTS orders_2025_01 PARTITION OF orders
  FOR VALUES FROM ('2025-01-01') TO ('2025-02-01');
CREATE TABLE IF NOT EXISTS orders_2025_02 PARTITION OF orders
  FOR VALUES FROM ('2025-02-01') TO ('2025-03-01');
CREATE TABLE IF NOT EXISTS orders_2025_03 PARTITION OF orders
  FOR VALUES FROM ('2025-03-01') TO ('2025-04-01');
CREATE TABLE IF NOT EXISTS orders_2025_04 PARTITION OF orders
  FOR VALUES FROM ('2025-04-01') TO ('2025-05-01');
CREATE TABLE IF NOT EXISTS orders_2025_05 PARTITION OF orders
  FOR VALUES FROM ('2025-05-01') TO ('2025-06-01');
CREATE TABLE IF NOT EXISTS orders_2025_06 PARTITION OF orders
  FOR VALUES FROM ('2025-06-01') TO ('2025-07-01');
CREATE TABLE IF NOT EXISTS orders_2025_07 PARTITION OF orders
  FOR VALUES FROM ('2025-07-01') TO ('2025-08-01');
CREATE TABLE IF NOT EXISTS orders_2025_08 PARTITION OF orders
  FOR VALUES FROM ('2025-08-01') TO ('2025-09-01');
CREATE TABLE IF NOT EXISTS orders_2025_09 PARTITION OF orders
  FOR VALUES FROM ('2025-09-01') TO ('2025-10-01');
CREATE TABLE IF NOT EXISTS orders_2025_10 PARTITION OF orders
  FOR VALUES FROM ('2025-10-01') TO ('2025-11-01');
CREATE TABLE IF NOT EXISTS orders_2025_11 PARTITION OF orders
  FOR VALUES FROM ('2025-11-01') TO ('2025-12-01');
CREATE TABLE IF NOT EXISTS orders_2025_12 PARTITION OF orders
  FOR VALUES FROM ('2025-12-01') TO ('2026-01-01');
CREATE TABLE IF NOT EXISTS orders_2026_01 PARTITION OF orders
  FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE IF NOT EXISTS orders_2026_02 PARTITION OF orders
  FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
CREATE TABLE IF NOT EXISTS orders_2026_03 PARTITION OF orders
  FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
CREATE TABLE IF NOT EXISTS orders_2026_04 PARTITION OF orders
  FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE IF NOT EXISTS orders_2026_05 PARTITION OF orders
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE IF NOT EXISTS orders_2026_06 PARTITION OF orders
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE IF NOT EXISTS orders_2026_07 PARTITION OF orders
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE IF NOT EXISTS orders_2026_08 PARTITION OF orders
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE IF NOT EXISTS orders_2026_09 PARTITION OF orders
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE IF NOT EXISTS orders_2026_10 PARTITION OF orders
  FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE IF NOT EXISTS orders_2026_11 PARTITION OF orders
  FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE IF NOT EXISTS orders_2026_12 PARTITION OF orders
  FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');

-- CRITICAL INDEXES on the partitioned orders table.
-- These propagate to all current and future partitions automatically.

-- 1. Dealer's order history — used by dealer app "My Orders" tab
CREATE INDEX IF NOT EXISTS idx_orders_dealer_created
  ON orders (dealer_id, created_at DESC);

-- 2. Zone + status + time — used by admin "All Indents" filtered by zone/status
CREATE INDEX IF NOT EXISTS idx_orders_zone_status_created
  ON orders (zone_id, status, created_at DESC);

-- 3. PARTIAL INDEX — only actionable orders (pending + confirmed).
--    Keeps the Dispatch Officer's pending orders query instant at any data volume.
--    Does NOT index delivered/cancelled rows (the vast majority of historical data).
CREATE INDEX IF NOT EXISTS idx_orders_actionable
  ON orders (status, created_at DESC)
  WHERE status IN ('pending', 'confirmed');

-- 4. Date range scans for reports
CREATE INDEX IF NOT EXISTS idx_orders_created
  ON orders (created_at DESC);


-- ── Order Items ──
CREATE TABLE IF NOT EXISTS order_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     uuid NOT NULL, -- references orders(id) — no FK because orders is partitioned
  product_id   uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  product_name text NOT NULL,
  quantity     integer NOT NULL,
  unit_price   numeric(10, 2) NOT NULL,
  gst_percent  numeric(5, 2) NOT NULL,
  gst_amount   numeric(10, 2) NOT NULL,
  line_total   numeric(10, 2) NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items (order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_product ON order_items (product_id);

-- ── Cancellation Requests ──
CREATE TABLE IF NOT EXISTS cancellation_requests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    uuid NOT NULL,
  dealer_id   uuid NOT NULL REFERENCES dealers(id) ON DELETE RESTRICT,
  reason      text NOT NULL,
  status      cancellation_status NOT NULL DEFAULT 'pending',
  reviewed_by uuid,
  review_note text,
  reviewed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cancellation_requests_order ON cancellation_requests (order_id);
CREATE INDEX IF NOT EXISTS idx_cancellation_requests_dealer ON cancellation_requests (dealer_id);
CREATE INDEX IF NOT EXISTS idx_cancellation_requests_status ON cancellation_requests (status);


-- ┌─────────────────────────────────────────┐
-- │         INVOICES & FINANCE               │
-- └─────────────────────────────────────────┘

-- ── Invoices ──
CREATE TABLE IF NOT EXISTS invoices (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id          uuid NOT NULL,
  dealer_id         uuid NOT NULL REFERENCES dealers(id) ON DELETE RESTRICT,
  invoice_number    text NOT NULL UNIQUE,
  invoice_date      timestamptz NOT NULL DEFAULT now(),
  taxable_amount    numeric(12, 2) NOT NULL,
  cgst              numeric(10, 2) NOT NULL,
  sgst              numeric(10, 2) NOT NULL,
  total_tax         numeric(10, 2) NOT NULL,
  total_amount      numeric(12, 2) NOT NULL,
  dealer_gst_number text,
  dealer_name       text NOT NULL,
  dealer_address    text,
  pdf_url           text,
  pdf_generated_at  timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_invoices_order ON invoices (order_id);
CREATE INDEX IF NOT EXISTS idx_invoices_dealer ON invoices (dealer_id);
CREATE INDEX IF NOT EXISTS idx_invoices_number ON invoices (invoice_number);
CREATE INDEX IF NOT EXISTS idx_invoices_date ON invoices (invoice_date);

-- ── Dealer Ledger — APPEND-ONLY ──
-- NEVER UPDATE. NEVER DELETE. Every transaction is an INSERT.
-- balance_after is the running balance for audit trail.
CREATE TABLE IF NOT EXISTS dealer_ledger (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dealer_id      uuid NOT NULL REFERENCES dealers(id) ON DELETE RESTRICT,
  type           ledger_type NOT NULL,
  amount         numeric(12, 2) NOT NULL,
  reference_id   uuid,
  reference_type ledger_ref_type NOT NULL,
  description    text,
  balance_after  numeric(12, 2) NOT NULL,
  performed_by   uuid,
  created_at     timestamptz NOT NULL DEFAULT now()
  -- NO updated_at — this table is NEVER updated
);
CREATE INDEX IF NOT EXISTS idx_dealer_ledger_dealer_created ON dealer_ledger (dealer_id, created_at);
CREATE INDEX IF NOT EXISTS idx_dealer_ledger_reference ON dealer_ledger (reference_id, reference_type);
CREATE INDEX IF NOT EXISTS idx_dealer_ledger_type ON dealer_ledger (type);

-- ── Settlements ──
CREATE TABLE IF NOT EXISTS settlements (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  settlement_date date NOT NULL,
  total_amount    numeric(14, 2) NOT NULL,
  dealer_count    integer NOT NULL,
  status          settlement_status NOT NULL DEFAULT 'pending',
  bank_reference  text,
  notes           text,
  processed_by    uuid,
  processed_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_settlements_date ON settlements (settlement_date);
CREATE INDEX IF NOT EXISTS idx_settlements_status ON settlements (status);

-- ── Bank Reconciliation ──
CREATE TABLE IF NOT EXISTS bank_reconciliation (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  date                  date NOT NULL,
  bank_statement_amount numeric(14, 2) NOT NULL,
  system_amount         numeric(14, 2) NOT NULL,
  difference            numeric(14, 2) NOT NULL,
  status                text NOT NULL DEFAULT 'pending',
  notes                 text,
  reconciled_by         uuid,
  reconciled_at         timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bank_recon_date ON bank_reconciliation (date);


-- ┌─────────────────────────────────────────┐
-- │         INVENTORY & DISTRIBUTION         │
-- └─────────────────────────────────────────┘

-- ── FGS Stock Log ──
CREATE TABLE IF NOT EXISTS fgs_stock_log (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  date       date NOT NULL,
  opening    integer NOT NULL DEFAULT 0,
  received   integer NOT NULL DEFAULT 0,
  dispatched integer NOT NULL DEFAULT 0,
  wastage    integer NOT NULL DEFAULT 0,
  closing    integer NOT NULL DEFAULT 0,
  entered_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, date)
);
CREATE INDEX IF NOT EXISTS idx_fgs_stock_date ON fgs_stock_log (date);
CREATE INDEX IF NOT EXISTS idx_fgs_stock_product ON fgs_stock_log (product_id);

-- ── Routes ──
CREATE TABLE IF NOT EXISTS routes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,
  name        text NOT NULL,
  zone_id     uuid NOT NULL REFERENCES zones(id) ON DELETE RESTRICT,
  stops       integer NOT NULL DEFAULT 0,
  distance_km numeric(6, 1),
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);

-- ── Vehicles ──
CREATE TABLE IF NOT EXISTS vehicles (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number       text NOT NULL UNIQUE,
  type         text NOT NULL DEFAULT 'truck',
  capacity     text,
  driver_name  text,
  driver_phone text,
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);

-- ── Route Assignments (daily dispatch) ──
CREATE TABLE IF NOT EXISTS route_assignments (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id             uuid NOT NULL REFERENCES routes(id) ON DELETE RESTRICT,
  vehicle_id           uuid REFERENCES vehicles(id) ON DELETE SET NULL,
  date                 date NOT NULL,
  driver_name          text,
  driver_phone         text,
  departure_time       time,
  actual_departure_time timestamptz,
  dealer_count         integer NOT NULL DEFAULT 0,
  item_count           integer NOT NULL DEFAULT 0,
  status               dispatch_status NOT NULL DEFAULT 'pending',
  notes                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_route_assignments_date ON route_assignments (date);
CREATE INDEX IF NOT EXISTS idx_route_assignments_route ON route_assignments (route_id);
CREATE INDEX IF NOT EXISTS idx_route_assignments_status ON route_assignments (status);


-- ┌─────────────────────────────────────────┐
-- │         BANNERS & NOTIFICATIONS          │
-- └─────────────────────────────────────────┘

-- ── Banners ──
CREATE TABLE IF NOT EXISTS banners (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title      text NOT NULL,
  subtitle   text,
  image_url  text,
  link_url   text,
  zone_id    uuid REFERENCES zones(id) ON DELETE SET NULL,
  start_date date NOT NULL,
  end_date   date NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_banners_dates ON banners (start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_banners_zone ON banners (zone_id);

-- ── Notifications Log ──
CREATE TABLE IF NOT EXISTS notifications_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_type   text NOT NULL,
  target_id     uuid,
  channel       notif_channel NOT NULL,
  title         text NOT NULL,
  message       text NOT NULL,
  data          text,
  status        delivery_status NOT NULL DEFAULT 'queued',
  error_message text,
  sent_at       timestamptz,
  delivered_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_target ON notifications_log (target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications_log (status);
CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications_log (created_at);


-- ┌─────────────────────────────────────────┐
-- │         SYSTEM SETTINGS                  │
-- └─────────────────────────────────────────┘

CREATE TABLE IF NOT EXISTS system_settings (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category   text NOT NULL,
  key        text NOT NULL,
  value      text NOT NULL,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (category, key)
);

CREATE TABLE IF NOT EXISTS notification_config (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_name     text NOT NULL UNIQUE,
  target_channel text NOT NULL,
  push_enabled   text NOT NULL DEFAULT 'true',
  sms_enabled    text NOT NULL DEFAULT 'false',
  email_enabled  text NOT NULL DEFAULT 'false',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);


-- ┌─────────────────────────────────────────┐
-- │   HELPER FUNCTION: CREATE PARTITION      │
-- │   Called by BullMQ on 25th of each month │
-- └─────────────────────────────────────────┘

CREATE OR REPLACE FUNCTION create_orders_partition(
  p_year integer,
  p_month integer
) RETURNS void AS $$
DECLARE
  partition_name text;
  start_date text;
  end_date text;
  next_year integer;
  next_month integer;
BEGIN
  partition_name := format('orders_%s_%s', p_year, lpad(p_month::text, 2, '0'));
  start_date := format('%s-%s-01', p_year, lpad(p_month::text, 2, '0'));

  IF p_month = 12 THEN
    next_year := p_year + 1;
    next_month := 1;
  ELSE
    next_year := p_year;
    next_month := p_month + 1;
  END IF;

  end_date := format('%s-%s-01', next_year, lpad(next_month::text, 2, '0'));

  -- Only create if it doesn't exist
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = partition_name
  ) THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF orders FOR VALUES FROM (%L) TO (%L)',
      partition_name, start_date, end_date
    );
    RAISE NOTICE 'Created partition: %', partition_name;
  ELSE
    RAISE NOTICE 'Partition already exists: %', partition_name;
  END IF;
END;
$$ LANGUAGE plpgsql;


-- ┌─────────────────────────────────────────┐
-- │   HELPER FUNCTION: updated_at trigger    │
-- └─────────────────────────────────────────┘

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply updated_at trigger to all tables that have an updated_at column.
-- NOT applied to: dealer_ledger (append-only), order_items, invoices, notifications_log.

CREATE TRIGGER trg_zones_updated_at BEFORE UPDATE ON zones
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_time_windows_updated_at BEFORE UPDATE ON time_windows
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_categories_updated_at BEFORE UPDATE ON categories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_products_updated_at BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_dealers_updated_at BEFORE UPDATE ON dealers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_dealer_wallets_updated_at BEFORE UPDATE ON dealer_wallets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_approval_requests_updated_at BEFORE UPDATE ON approval_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_cancellation_requests_updated_at BEFORE UPDATE ON cancellation_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_fgs_stock_log_updated_at BEFORE UPDATE ON fgs_stock_log
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_routes_updated_at BEFORE UPDATE ON routes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_vehicles_updated_at BEFORE UPDATE ON vehicles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_route_assignments_updated_at BEFORE UPDATE ON route_assignments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_banners_updated_at BEFORE UPDATE ON banners
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_settlements_updated_at BEFORE UPDATE ON settlements
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_system_settings_updated_at BEFORE UPDATE ON system_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_notification_config_updated_at BEFORE UPDATE ON notification_config
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ┌─────────────────────────────────────────┐
-- │           SEED DATA                      │
-- └─────────────────────────────────────────┘

-- ── Zones ──
INSERT INTO zones (name, slug, icon, color, active) VALUES
  ('Haveri',     'haveri',     '🏛️', '#1448CC', true),
  ('Ranebennur', 'ranebennur', '🌎', '#D97706', true),
  ('Savanur',    'savanur',    '🏘️', '#16A34A', true),
  ('Byadgi',     'byadgi',     '🌿', '#DC2626', true),
  ('Hirekerur',  'hirekerur',  '🏡', '#9333EA', true),
  ('Hangal',     'hangal',     '🌿', '#0891B2', true)
ON CONFLICT (slug) DO NOTHING;

-- ── Time Windows (default: 6:00 AM – 8:00 AM, 20 min warning) ──
INSERT INTO time_windows (zone_id, open_time, warning_minutes, close_time)
SELECT z.id, '06:00'::time, 20, '08:00'::time
FROM zones z
WHERE z.slug IN ('haveri', 'ranebennur', 'byadgi', 'hirekerur', 'hangal')
ON CONFLICT (zone_id) DO NOTHING;

-- Savanur has a later window
INSERT INTO time_windows (zone_id, open_time, warning_minutes, close_time)
SELECT z.id, '06:30'::time, 15, '08:30'::time
FROM zones z
WHERE z.slug = 'savanur'
ON CONFLICT (zone_id) DO NOTHING;

-- ── Categories ──
INSERT INTO categories (name, icon, sort_order) VALUES
  ('Milk',       '🥛', 1),
  ('Curd',       '🫙', 2),
  ('Butter',     '🧈', 3),
  ('Ghee',       '🫙', 4),
  ('Paneer',     '🧀', 5),
  ('Flavoured',  '🍫', 6),
  ('Beverages',  '🥤', 7),
  ('Sweets',     '🍮', 8)
ON CONFLICT (name) DO NOTHING;

-- ── Products ──
-- Prices and GST rates from the design mockup
INSERT INTO products (name, category_id, icon, unit, base_price, gst_percent, stock, available, sort_order)
SELECT p.name, c.id, p.icon, p.unit, p.base_price, p.gst_percent, p.stock, true, p.sort_order
FROM (VALUES
  ('Full Cream Milk',  'Milk',      '🥛', '500ml Pouch', 28.00,  5.00, 120, 1),
  ('Toned Milk',       'Milk',      '🥛', '500ml Pouch', 24.00,  5.00, 200, 2),
  ('Curd Cup',         'Curd',      '🫙', '400ml',       34.00,  5.00, 85,  3),
  ('Buttermilk',       'Beverages', '🥤', '200ml',       15.00, 12.00, 150, 4),
  ('Fresh Paneer',     'Paneer',    '🧀', '200g Block',  95.00,  5.00, 45,  5),
  ('Pure Ghee',        'Ghee',      '🫙', '500ml Jar',  280.00, 12.00, 30,  6),
  ('Mango Lassi',      'Flavoured', '🥤', '200ml',       20.00, 12.00, 100, 7),
  ('Premium Butter',   'Butter',    '🧈', '100g Block',  58.00, 12.00, 60,  8),
  ('Shrikhand',        'Sweets',    '🍮', '100g Cup',    45.00,  5.00, 40,  9),
  ('Choco Milk',       'Flavoured', '🍫', '200ml',       25.00, 12.00, 90, 10),
  ('Peda',             'Sweets',    '🍮', '250g Box',    120.00, 5.00, 25, 11),
  ('Mysore Pak',       'Sweets',    '🍮', '250g Box',    110.00, 5.00,  0, 12)
) AS p(name, cat_name, icon, unit, base_price, gst_percent, stock, sort_order)
JOIN categories c ON c.name = p.cat_name
ON CONFLICT DO NOTHING;

-- ── System Settings (defaults from General Settings page) ──
INSERT INTO system_settings (category, key, value) VALUES
  ('organization', 'name',          'Haveri District Co-operative Milk Producers'' Union'),
  ('organization', 'short_name',    'Haveri Milk Union'),
  ('organization', 'gstin',         '29AABCH1234F1Z5'),
  ('organization', 'contact_email', 'admin@haverimunion.coop'),
  ('organization', 'contact_phone', '+91 8382 123456'),
  ('app_config',   'app_name',      'Haveri Milk Union - Dealer Portal'),
  ('app_config',   'currency',      'INR'),
  ('app_config',   'timezone',      'Asia/Kolkata'),
  ('app_config',   'invoice_prefix','INV-HMU-'),
  ('app_config',   'order_prefix',  '#HMU-'),
  ('address',      'line1',         'Haveri District Co-operative Milk Producers'' Union Ltd'),
  ('address',      'line2',         'Main Road, Haveri'),
  ('address',      'city_district', 'Haveri, Karnataka'),
  ('address',      'pin_code',      '581110'),
  ('bank',         'bank_name',     'State Bank of India'),
  ('bank',         'account_number','XXXXXXXX1234'),
  ('bank',         'ifsc_code',     'SBIN0001234'),
  ('bank',         'upi_id',        'haverimunion@sbi')
ON CONFLICT (category, key) DO NOTHING;

-- ── Notification Config (defaults from Notifications page) ──
INSERT INTO notification_config (event_name, target_channel, push_enabled, sms_enabled, email_enabled) VALUES
  ('new_indent_placed',  'dealers', 'true',  'true',  'false'),
  ('order_confirmed',    'dealers', 'true',  'false', 'true'),
  ('order_dispatched',   'dealers', 'true',  'true',  'false'),
  ('payment_received',   'admin',   'true',  'false', 'true'),
  ('low_stock_alert',    'admin',   'true',  'false', 'true'),
  ('new_registration',   'admin',   'true',  'false', 'true'),
  ('window_opening',     'dealers', 'true',  'true',  'false'),
  ('window_closing_soon','dealers', 'true',  'false', 'false')
ON CONFLICT (event_name) DO NOTHING;


-- ┌─────────────────────────────────────────┐
-- │           DONE                           │
-- └─────────────────────────────────────────┘
-- Migration complete. All tables created with:
-- ✓ Partitioned orders table (2025-01 through 2026-12)
-- ✓ Critical indexes including partial index on actionable orders
-- ✓ Automatic updated_at triggers
-- ✓ Partition creation helper function
-- ✓ Seed data for zones, time windows, categories, products, settings
