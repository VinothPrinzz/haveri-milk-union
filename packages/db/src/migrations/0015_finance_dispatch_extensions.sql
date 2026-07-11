-- ══════════════════════════════════════════════════════════════════
-- Haveri Milk Union — Finance + Dispatch Extensions Migration
-- 0015_finance_dispatch_extensions.sql
--
-- Schema changes for the 6 new features:
--   1. Dispatch Sheet revamp + Create Dispatch
--   2. Invoices page (list + A4 detail)
--   3. Payments Overview
--   4. Dealer Ledger / Wallet
--   5. Price Revisions list
--
-- New columns on existing tables (all nullable / defaulted, so old
-- rows stay valid and append-only ledger discipline is preserved):
--   • dealers.{opening_balance, opening_balance_date}
--     — credit_limit already exists in 0001, reused as-is
--   • invoices.{route_id, payment_status, paid_amount, due_date}
--   • dealer_ledger.{voucher_no, voucher_type, particulars, voucher_date}
--
-- New table:
--   • payments — one row per receipt against a dealer (cash/upi/cheque/
--     neft/rtgs/credit). Insert flow (in API tx): payments → ledger →
--     invoices.payment_status update. NEVER updated by triggers — all
--     side-effects live in the application transaction.
--
-- New indexes for the 100+ dealer × large daily order load:
--   • orders dispatch-status filter (partial, partition-pruned)
--   • payments by dealer + date
--   • dealer_ledger by dealer + created_at (ledger paging)
--   • invoices by dealer + date (verify only — added in 0001)
--
-- Backfills:
--   • invoices.route_id   ← dealers.route_id
--   • invoices.payment_status defaulted to 'unpaid' (no historic data
--     to derive from — accountant can adjust)
--   • dealer_ledger.voucher_type ← derived from reference_type
--   • dealer_ledger.voucher_no   ← short hash of reference_id
--   • dealer_ledger.voucher_date ← created_at::date
--
-- Idempotent. Re-running this migration is safe.
-- Run with: psql $DATABASE_URL -f 0015_finance_dispatch_extensions.sql
-- ══════════════════════════════════════════════════════════════════


-- ┌─────────────────────────────────────────┐
-- │   1. DEALERS — opening balance only       │
-- └─────────────────────────────────────────┘
-- Note: dealers.credit_limit already exists in 0001 (numeric(10,2)
-- NOT NULL DEFAULT 0). Reusing it as-is — no schema change needed.

ALTER TABLE dealers
  ADD COLUMN IF NOT EXISTS opening_balance       numeric(12, 2) NOT NULL DEFAULT 0;
ALTER TABLE dealers
  ADD COLUMN IF NOT EXISTS opening_balance_date  date;

-- Default opening_balance_date to the dealer's creation date when the
-- accountant hasn't set one yet. Cheap one-shot backfill.
UPDATE dealers
SET opening_balance_date = created_at::date
WHERE opening_balance_date IS NULL
  AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_dealers_credit_limit
  ON dealers (credit_limit)
  WHERE credit_limit > 0 AND deleted_at IS NULL;


-- ┌─────────────────────────────────────────┐
-- │   2. INVOICES — route snapshot + payment  │
-- └─────────────────────────────────────────┘

-- Snapshot of the dealer's route at invoice time. Joining via
-- dealers.route_id at read time is fragile — a dealer's route can
-- change after the invoice is issued.
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS route_id uuid REFERENCES routes(id) ON DELETE SET NULL;

-- Payment lifecycle on the invoice itself. The authoritative source of
-- truth is still payments + dealer_ledger; this is a denormalised
-- field for fast list queries (avoids per-row aggregation).
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS payment_status text NOT NULL DEFAULT 'unpaid';

DO $$ BEGIN
  ALTER TABLE invoices
    ADD CONSTRAINT invoices_payment_status_check
    CHECK (payment_status IN ('paid','unpaid','partial'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS paid_amount numeric(12, 2) NOT NULL DEFAULT 0;
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS due_date date;

-- Backfill route snapshot for existing invoices.
UPDATE invoices i
SET route_id = d.route_id
FROM dealers d
WHERE d.id = i.dealer_id
  AND i.route_id IS NULL
  AND d.route_id IS NOT NULL;

-- Backfill due_date for existing invoices: invoice_date + 7 days
-- (default credit period; accountant can override per-invoice later).
UPDATE invoices
SET due_date = (invoice_date::date + INTERVAL '7 days')::date
WHERE due_date IS NULL;

CREATE INDEX IF NOT EXISTS idx_invoices_route
  ON invoices (route_id)
  WHERE route_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_invoices_payment_status
  ON invoices (payment_status)
  WHERE payment_status <> 'paid';
CREATE INDEX IF NOT EXISTS idx_invoices_due_date
  ON invoices (due_date)
  WHERE payment_status <> 'paid';


-- ┌─────────────────────────────────────────┐
-- │   3. DEALER_LEDGER — voucher metadata     │
-- └─────────────────────────────────────────┘
-- Append-only discipline preserved: these columns are populated on
-- INSERT only. No triggers, no UPDATE paths in any new API code.

ALTER TABLE dealer_ledger ADD COLUMN IF NOT EXISTS voucher_no    text;
ALTER TABLE dealer_ledger ADD COLUMN IF NOT EXISTS voucher_type  text;
ALTER TABLE dealer_ledger ADD COLUMN IF NOT EXISTS particulars   text;
ALTER TABLE dealer_ledger ADD COLUMN IF NOT EXISTS voucher_date  date;

DO $$ BEGIN
  ALTER TABLE dealer_ledger
    ADD CONSTRAINT dealer_ledger_voucher_type_check
    CHECK (voucher_type IS NULL OR voucher_type IN
      ('Invoice','Receipt','Adjustment','Opening','Refund'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Backfill voucher_type from existing reference_type.
UPDATE dealer_ledger
SET voucher_type = CASE reference_type
  WHEN 'order'        THEN 'Invoice'
  WHEN 'wallet_topup' THEN 'Receipt'
  WHEN 'refund'       THEN 'Refund'
  WHEN 'adjustment'   THEN 'Adjustment'
  ELSE 'Adjustment'
END
WHERE voucher_type IS NULL;

-- Backfill voucher_date.
UPDATE dealer_ledger
SET voucher_date = created_at::date
WHERE voucher_date IS NULL;

-- Backfill voucher_no — short, human-readable surrogate. For order
-- vouchers, prefer the actual invoice_number when it can be resolved.
UPDATE dealer_ledger dl
SET voucher_no = i.invoice_number
FROM invoices i
WHERE dl.reference_type = 'order'
  AND dl.reference_id = i.order_id
  AND dl.voucher_no IS NULL;

-- For everything else (and any orders whose invoice hasn't been
-- generated yet), fall back to a typed short-id.
UPDATE dealer_ledger
SET voucher_no = CASE voucher_type
  WHEN 'Invoice'    THEN 'INV-' || UPPER(SUBSTRING(reference_id::text, 1, 8))
  WHEN 'Receipt'    THEN 'RC-'  || UPPER(SUBSTRING(reference_id::text, 1, 8))
  WHEN 'Refund'     THEN 'RF-'  || UPPER(SUBSTRING(reference_id::text, 1, 8))
  WHEN 'Adjustment' THEN 'ADJ-' || UPPER(SUBSTRING(id::text, 1, 8))
  WHEN 'Opening'    THEN 'OPEN-' || UPPER(SUBSTRING(id::text, 1, 8))
  ELSE 'LED-' || UPPER(SUBSTRING(id::text, 1, 8))
END
WHERE voucher_no IS NULL;

-- Backfill particulars where missing — fall back to existing description.
UPDATE dealer_ledger
SET particulars = COALESCE(particulars, description, voucher_type)
WHERE particulars IS NULL;

-- Index for ledger paging (dealer + date range queries).
-- Note: idx_dealer_ledger_dealer_created already exists from 0001 on
-- (dealer_id, created_at) ASC — Postgres scans it backwards for our
-- DESC paging. We add only the voucher_date variant here.
CREATE INDEX IF NOT EXISTS idx_dealer_ledger_dealer_voucher_date
  ON dealer_ledger (dealer_id, voucher_date DESC)
  WHERE voucher_date IS NOT NULL;


-- ┌─────────────────────────────────────────┐
-- │   4. PAYMENTS — new table                 │
-- └─────────────────────────────────────────┘
-- One row per receipt. Inserted by the API in a single transaction
-- alongside the matching dealer_ledger row and the invoice
-- payment_status update. No triggers — keeps invariants in app code
-- where they're testable.
--
-- invoice_id is nullable: receipts can be on-account (not tied to a
-- specific invoice). Reference is freeform — UPI txn id, cheque no,
-- bank ref, etc.

CREATE TABLE IF NOT EXISTS payments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dealer_id     uuid NOT NULL REFERENCES dealers(id) ON DELETE RESTRICT,
  received_date date NOT NULL DEFAULT CURRENT_DATE,
  amount        numeric(12, 2) NOT NULL CHECK (amount > 0),
  mode          text NOT NULL,
  reference     text,
  invoice_id    uuid REFERENCES invoices(id) ON DELETE SET NULL,
  received_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE payments
    ADD CONSTRAINT payments_mode_check
    CHECK (mode IN ('cash','upi','cheque','neft','rtgs','credit','wallet'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_payments_dealer_date
  ON payments (dealer_id, received_date DESC);
CREATE INDEX IF NOT EXISTS idx_payments_invoice
  ON payments (invoice_id)
  WHERE invoice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payments_date
  ON payments (received_date DESC);
CREATE INDEX IF NOT EXISTS idx_payments_mode
  ON payments (mode);

-- updated_at trigger — using set_updated_at() from 0001.
DO $$ BEGIN
  CREATE TRIGGER trg_payments_updated_at
    BEFORE UPDATE ON payments
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ┌─────────────────────────────────────────┐
-- │   5. ORDERS — dispatch-sheet hot path     │
-- └─────────────────────────────────────────┘
-- The Dispatch Sheet aggregates order_items for a given route+date.
-- The query path is:
--   orders (filter: created_at::date = $date AND status IN ...)
--     → JOIN dealers (filter: route_id = $route)
--     → JOIN order_items
--     → JOIN products
--
-- This partial composite index keeps the orders scan cheap on days
-- with hundreds of dealers. Postgres applies it per-partition since
-- orders is partitioned monthly.

CREATE INDEX IF NOT EXISTS idx_orders_dispatch_status_created
  ON orders (created_at, status)
  WHERE status IN ('pending','confirmed','dispatched');


-- ┌─────────────────────────────────────────┐
-- │   6. PRICE_REVISIONS — listing index      │
-- └─────────────────────────────────────────┘
-- The new GET /price-revisions endpoint sorts by effective_from DESC
-- with optional product filter. This index covers both.
CREATE INDEX IF NOT EXISTS idx_price_revisions_effective_from
  ON price_revisions (effective_from DESC, product_id);


-- ┌─────────────────────────────────────────┐
-- │   7. SEED — Opening balance ledger rows   │
-- └─────────────────────────────────────────┘
-- For every dealer with a non-zero opening_balance that doesn't
-- already have an 'Opening' voucher in their ledger, insert one.
-- This guarantees the ledger summary endpoint returns a correct
-- opening balance for any date range.
--
-- Safe to re-run: WHERE NOT EXISTS guard prevents duplicates.

INSERT INTO dealer_ledger (
  dealer_id, type, amount, reference_id, reference_type,
  description, balance_after,
  voucher_no, voucher_type, particulars, voucher_date,
  created_at
)
SELECT
  d.id,
  CASE WHEN d.opening_balance >= 0 THEN 'credit' ELSE 'debit' END,
  ABS(d.opening_balance),
  d.id,                            -- self-ref for opening row
  'adjustment',
  'Opening Balance',
  d.opening_balance,               -- running balance starts here
  'OPEN-' || UPPER(SUBSTRING(d.id::text, 1, 8)),
  'Opening',
  'Opening Balance',
  COALESCE(d.opening_balance_date, d.created_at::date),
  COALESCE(d.opening_balance_date, d.created_at::date)::timestamptz
FROM dealers d
WHERE d.deleted_at IS NULL
  AND d.opening_balance <> 0
  AND NOT EXISTS (
    SELECT 1 FROM dealer_ledger dl
    WHERE dl.dealer_id = d.id
      AND dl.voucher_type = 'Opening'
  );


-- ══════════════════════════════════════════════════════════════════
-- DONE.
--
-- New columns:
--   ✓ dealers       (opening_balance, opening_balance_date)
--                   credit_limit reused from 0001 — no schema change
--   ✓ invoices      (route_id, payment_status, paid_amount, due_date)
--   ✓ dealer_ledger (voucher_no, voucher_type, particulars, voucher_date)
--
-- New table:
--   ✓ payments
--
-- New indexes:
--   ✓ idx_dealers_credit_limit (partial)
--   ✓ idx_invoices_route, idx_invoices_payment_status, idx_invoices_due_date
--   ✓ idx_dealer_ledger_dealer_voucher_date (new — created_at variant
--     already exists from 0001)
--   ✓ idx_payments_dealer_date, idx_payments_invoice, idx_payments_date,
--     idx_payments_mode
--   ✓ idx_orders_dispatch_status_created (partial — dispatch hot path)
--   ✓ idx_price_revisions_effective_from
--
-- Backfills:
--   ✓ dealers.opening_balance_date          ← created_at::date
--   ✓ invoices.route_id                     ← dealers.route_id
--   ✓ invoices.due_date                     ← invoice_date + 7 days
--   ✓ dealer_ledger.voucher_type            ← reference_type mapping
--   ✓ dealer_ledger.voucher_date            ← created_at::date
--   ✓ dealer_ledger.voucher_no              ← invoice_number / typed short-id
--   ✓ dealer_ledger.particulars             ← description / voucher_type
--   ✓ dealer_ledger Opening rows for non-zero opening_balance dealers
--
-- Triggers:
--   ✓ trg_payments_updated_at
--
-- Run EXPLAIN ANALYZE after migrating to verify the dispatch-sheet
-- aggregation query stays under 100ms with 100+ dealers per route.
-- ══════════════════════════════════════════════════════════════════
