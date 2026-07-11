-- ════════════════════════════════════════════════════════════════════
-- Haveri Milk Union — Order Delivery Date + Draft Status
-- 0031_orders_delivery_date.sql
--
-- Why:
--   The dealer-app redesign lets a dealer place an order for a
--   future date — "set up Thursday's indent now, on Tuesday." That
--   requires separating WHEN the order was placed (`created_at`)
--   from WHEN it's scheduled for delivery (`delivery_date`).
--
--   It also introduces a "draft" lifecycle stage: the nightly worker
--   pre-creates a draft order for each dealer from their standing
--   indent. The dealer edits the draft via the Indent tab. At the
--   zone's `close_time` on the delivery date, the worker either
--   confirms the draft (if credit/payment is OK) or flags it as
--   payment-required.
--
--   Existing flow today: dealer hits "Place Order" → status='pending'
--   immediately. That still works (the new statuses are additive).
--
-- What:
--   1. orders.delivery_date (date)         — when this order will be
--                                            delivered. Defaulted to
--                                            created_at::date for
--                                            historical rows.
--   2. order_status enum gets two new values:
--        'draft'              — pre-confirm; editable by dealer
--        'payment_required'   — close_time passed, credit insufficient,
--                                no Razorpay payment received yet
--   3. Indexes for the worker's hot queries.
--
-- Partitioning note:
--   `orders` is range-partitioned on created_at (see schema/orders.ts).
--   Adding a column to a partitioned parent table cascades to all
--   partitions automatically in Postgres 11+. No special handling.
-- ════════════════════════════════════════════════════════════════════


-- ── 1. New status enum values ──
-- These add to the existing order_status enum. Postgres allows
-- ADD VALUE inside a transaction in 12+; we use IF NOT EXISTS so
-- re-running this migration is safe.

DO $$ BEGIN
  ALTER TYPE order_status ADD VALUE IF NOT EXISTS 'draft' BEFORE 'pending';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TYPE order_status ADD VALUE IF NOT EXISTS 'payment_required' AFTER 'pending';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ── 2. Delivery date column ──
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS delivery_date date;

-- Backfill historical rows: delivery_date = created_at::date.
-- Same-day model assumed for everything pre-redesign.
UPDATE orders
SET delivery_date = (created_at AT TIME ZONE 'Asia/Kolkata')::date
WHERE delivery_date IS NULL;

-- Once backfilled, make it NOT NULL going forward.
ALTER TABLE orders
  ALTER COLUMN delivery_date SET NOT NULL;

-- New rows default to today's IST date if not specified. The API
-- always specifies it explicitly; this default is just a safety net.
ALTER TABLE orders
  ALTER COLUMN delivery_date SET DEFAULT ((now() AT TIME ZONE 'Asia/Kolkata')::date);


-- ── 3. Uniqueness: one draft per dealer per delivery_date ──
-- Prevents the materializer from creating duplicate drafts if it
-- crashes mid-run and retries. Only applies to draft+pending; once
-- confirmed/cancelled, dealers can have multiple historical orders
-- for the same date (rare, but supported).
CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_dealer_delivery_draft
  ON orders (dealer_id, delivery_date)
  WHERE status IN ('draft', 'pending');


-- ── 4. Worker query indexes ──

-- Closing-time job: "find all draft orders for today's delivery_date
-- in zone X" → confirm or flag.
CREATE INDEX IF NOT EXISTS idx_orders_draft_delivery
  ON orders (delivery_date, zone_id)
  WHERE status = 'draft';

-- Payment-required surfacing for the dealer app banner:
-- "show me any of my orders that need payment right now".
CREATE INDEX IF NOT EXISTS idx_orders_payment_required
  ON orders (dealer_id, delivery_date)
  WHERE status = 'payment_required';

-- General delivery-date scans (route sheets, dispatch planning).
CREATE INDEX IF NOT EXISTS idx_orders_delivery_date
  ON orders (delivery_date)
  WHERE status NOT IN ('cancelled');


-- ════════════════════════════════════════════════════════════════════
-- Done. After this:
--   • orders.delivery_date separates placement time from delivery time.
--   • order_status gains 'draft' and 'payment_required' lifecycle stages.
--   • Workers have the indexes they need for hot queries.
--
-- Caller-side changes that must ship alongside this migration:
--   • POST /api/v1/orders  — accept `deliveryDate` in body, default to
--                            today's IST date when not provided.
--   • Credit check         — run at status transition draft→pending,
--                            not at draft creation (allows future-dated
--                            drafts even when today's credit is tight).
--   • Worker materializer  — INSERT INTO orders ... status='draft'.
-- ════════════════════════════════════════════════════════════════════
