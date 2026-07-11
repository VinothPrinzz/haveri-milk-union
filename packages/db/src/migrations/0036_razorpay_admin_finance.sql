-- ════════════════════════════════════════════════════════════════════
-- Haveri Milk Union — Razorpay Admin Finance
-- 0036_razorpay_admin_finance.sql
--
-- Why:
--   0032 shipped the dealer-facing Razorpay flow (credit top-up +
--   per-order pay-now). It gave us `razorpay_payments` and wired the
--   dealer app. It did NOT give the FINANCE TEAM anything:
--
--     • No admin surface to see online payments.
--     • No way to reconcile what Razorpay collected against what
--       actually landed in the Axis Bank current account. Razorpay
--       settles in T+2 batches (a payout, identified by a UTR /
--       bank reference) — many dealer payments collapse into one
--       bank credit. Finance must tie those together or the books
--       never close.
--     • No refund record. `razorpay_payment_status` has a 'refunded'
--       value but nothing ever sets it, and Razorpay allows MULTIPLE
--       PARTIAL refunds per payment — a single status column cannot
--       model that.
--
-- What this migration adds:
--   1. razorpay_payments.amount_refunded   — running partial-refund
--      total, so status can stay 'paid' until fully refunded.
--   2. razorpay_payments.settlement_id     — FK to settlements; set
--      when a payment is matched into an Axis Bank payout batch.
--   3. razorpay_payments.reconciled_at     — stamp set by the
--      reconciliation screen once a row is confirmed against the
--      internal `payments` ledger.
--   4. settlements extensions              — the settlements table
--      from 0001 becomes the Razorpay→Axis payout batch record:
--      razorpay_settlement_id, utr, gateway_fee, tax_on_fee,
--      axis_credited_amount, axis_value_date.
--   5. razorpay_refunds table              — one row per refund
--      (partial or full). Append-only, like dealer_ledger.
--   6. razorpay_refund_status enum.
--   7. Indexes for the admin hot read paths.
--
-- Idempotent. Safe to re-run.
-- Run with: psql $DATABASE_URL -f 0036_razorpay_admin_finance.sql
-- ════════════════════════════════════════════════════════════════════


-- ┌─────────────────────────────────────────┐
-- │  1. razorpay_payments — new columns       │
-- └─────────────────────────────────────────┘

ALTER TABLE razorpay_payments
  ADD COLUMN IF NOT EXISTS amount_refunded numeric(10, 2) NOT NULL DEFAULT 0
    CHECK (amount_refunded >= 0);

-- Set when the reconciliation screen ties this payment to an Axis
-- Bank payout batch. NULL = not yet settled / not yet matched.
ALTER TABLE razorpay_payments
  ADD COLUMN IF NOT EXISTS settlement_id uuid
    REFERENCES settlements(id) ON DELETE SET NULL;

-- Stamp set when finance confirms this Razorpay row has a matching
-- internal `payments` row (i.e. applyPaidPayment ran and the books
-- agree). NULL = needs review on the reconciliation screen.
ALTER TABLE razorpay_payments
  ADD COLUMN IF NOT EXISTS reconciled_at timestamptz;

-- A refund can never exceed what was captured.
DO $$ BEGIN
  ALTER TABLE razorpay_payments
    ADD CONSTRAINT razorpay_payments_refund_within_amount
    CHECK (amount_refunded <= amount);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ┌─────────────────────────────────────────┐
-- │  2. settlements — Razorpay→Axis payout    │
-- └─────────────────────────────────────────┘
-- The settlements table (0001) was a stub. It now models a real
-- Razorpay settlement: gross collected, fee + GST deducted by
-- Razorpay, and the NET that Axis Bank credits to the current a/c.
--
--   reconciliation_check:
--     total_amount (gross) - gateway_fee - tax_on_fee
--       should equal axis_credited_amount
--   when it doesn't, finance investigates.

ALTER TABLE settlements
  ADD COLUMN IF NOT EXISTS razorpay_settlement_id text UNIQUE;

-- Bank UTR / RRN of the Axis Bank credit leg. This is the string
-- finance matches against the Axis statement.
ALTER TABLE settlements
  ADD COLUMN IF NOT EXISTS utr text;

ALTER TABLE settlements
  ADD COLUMN IF NOT EXISTS gateway_fee numeric(12, 2) NOT NULL DEFAULT 0;

ALTER TABLE settlements
  ADD COLUMN IF NOT EXISTS tax_on_fee numeric(12, 2) NOT NULL DEFAULT 0;

-- Net amount Axis Bank actually credited. Defaults to total_amount;
-- finance corrects it from the bank statement.
ALTER TABLE settlements
  ADD COLUMN IF NOT EXISTS axis_credited_amount numeric(14, 2);

ALTER TABLE settlements
  ADD COLUMN IF NOT EXISTS axis_value_date date;

CREATE INDEX IF NOT EXISTS idx_settlements_razorpay_id
  ON settlements (razorpay_settlement_id)
  WHERE razorpay_settlement_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_settlements_utr
  ON settlements (utr)
  WHERE utr IS NOT NULL;


-- ┌─────────────────────────────────────────┐
-- │  3. razorpay_refund_status enum           │
-- └─────────────────────────────────────────┘
DO $$ BEGIN
  CREATE TYPE razorpay_refund_status AS ENUM (
    'pending',     -- refund POSTed to Razorpay, not yet confirmed
    'processed',   -- Razorpay confirmed the refund
    'failed'       -- Razorpay rejected / could not process
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ┌─────────────────────────────────────────┐
-- │  4. razorpay_refunds table                │
-- └─────────────────────────────────────────┘
-- One row per refund. A payment may have several (partial refunds).
-- APPEND-ONLY for the money trail — status is the only mutable field
-- (pending → processed / failed), updated by the webhook or the
-- finance screen.

CREATE TABLE IF NOT EXISTS razorpay_refunds (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The payment being refunded.
  razorpay_payment_row uuid NOT NULL
                       REFERENCES razorpay_payments(id) ON DELETE RESTRICT,
  dealer_id            uuid NOT NULL
                       REFERENCES dealers(id) ON DELETE RESTRICT,

  -- Razorpay's identifiers.
  razorpay_refund_id   text UNIQUE,            -- rfnd_xxxxxx
  razorpay_payment_id  text NOT NULL,          -- pay_xxxxxx (denormalised)

  -- Money.
  amount               numeric(10, 2) NOT NULL CHECK (amount > 0),
  currency             text NOT NULL DEFAULT 'INR',

  status               razorpay_refund_status NOT NULL DEFAULT 'pending',

  -- Why the refund was issued + who clicked the button.
  reason               text NOT NULL,
  initiated_by         uuid REFERENCES users(id) ON DELETE SET NULL,

  -- The reversing dealer_ledger row (a 'debit', voucher_type 'Refund')
  -- written when the refund is initiated. NULL only if the dealer had
  -- no ledger credit to reverse (rare — e.g. order_payment on a
  -- non-credit order).
  ledger_entry_id      uuid REFERENCES dealer_ledger(id) ON DELETE SET NULL,

  -- Failure detail from Razorpay.
  error_description    text,

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  processed_at         timestamptz
);

CREATE INDEX IF NOT EXISTS idx_razorpay_refunds_payment_row
  ON razorpay_refunds (razorpay_payment_row);
CREATE INDEX IF NOT EXISTS idx_razorpay_refunds_dealer
  ON razorpay_refunds (dealer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_razorpay_refunds_status
  ON razorpay_refunds (status);

DO $$ BEGIN
  CREATE TRIGGER trg_razorpay_refunds_updated_at
    BEFORE UPDATE ON razorpay_refunds
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ┌─────────────────────────────────────────┐
-- │  5. Admin read-path indexes               │
-- └─────────────────────────────────────────┘
-- The Online Payments screen filters by status + date and the
-- reconciliation screen scans unreconciled rows.

CREATE INDEX IF NOT EXISTS idx_razorpay_payments_status_created
  ON razorpay_payments (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_razorpay_payments_unreconciled
  ON razorpay_payments (paid_at)
  WHERE status = 'paid' AND reconciled_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_razorpay_payments_settlement
  ON razorpay_payments (settlement_id)
  WHERE settlement_id IS NOT NULL;


-- ════════════════════════════════════════════════════════════════════
-- DONE.
--
-- New columns:
--   ✓ razorpay_payments (amount_refunded, settlement_id, reconciled_at)
--   ✓ settlements       (razorpay_settlement_id, utr, gateway_fee,
--                        tax_on_fee, axis_credited_amount, axis_value_date)
-- New enum:
--   ✓ razorpay_refund_status
-- New table:
--   ✓ razorpay_refunds
--
-- The finance team can now: list online payments, refund them
-- (partial or full), and reconcile Razorpay collections against
-- Axis Bank payout batches.
-- ════════════════════════════════════════════════════════════════════
