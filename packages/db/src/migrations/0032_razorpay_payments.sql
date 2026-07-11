-- ════════════════════════════════════════════════════════════════════
-- Haveri Milk Union — Razorpay Payments
-- 0032_razorpay_payments.sql
--
-- Why:
--   Two new dealer-initiated payment flows ship in Phase 2B:
--
--   1. CREDIT TOP-UP — dealer pays via Razorpay to reduce their
--      outstanding balance. This frees up credit (available credit
--      = limit - outstanding). The credit limit itself is unchanged
--      — admin still controls that.
--
--   2. PER-ORDER PAYMENT — dealer's order failed the credit check
--      and sits in `payment_required`. They hit "Pay now" and pay
--      the full grand_total via Razorpay. On success the order
--      transitions to `confirmed`.
--
--   Razorpay state (the orderId/paymentId/signature triplet, retry
--   counts, webhook idempotency) is separate from our internal
--   payments / dealer_ledger model. This table holds the Razorpay
--   side; the existing `payments` + `dealer_ledger` tables get
--   their rows inserted on signature verification, exactly like
--   the admin-recorded cash receipt flow does today.
--
-- What:
--   • razorpay_payment_kind enum     ('credit_topup', 'order_payment')
--   • razorpay_payment_status enum   ('created' .. 'refunded')
--   • razorpay_payments table        — one row per Razorpay order we
--                                       create. Order id is unique.
--   • Three indexes for the hot read paths.
-- ════════════════════════════════════════════════════════════════════

-- ── 1. Enums ──
DO $$ BEGIN
  CREATE TYPE razorpay_payment_kind AS ENUM (
    'credit_topup',
    'order_payment'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE razorpay_payment_status AS ENUM (
    'created',     -- we created the Razorpay order; user hasn't paid yet
    'attempted',   -- user opened the SDK; transient
    'paid',        -- signature verified, ledger updated, all good
    'failed',      -- user cancelled / card declined / webhook reported failure
    'refunded'     -- finance-team initiated refund (manual)
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ── 2. Table ──
CREATE TABLE IF NOT EXISTS razorpay_payments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Who's paying
  dealer_id           uuid NOT NULL
                      REFERENCES dealers(id) ON DELETE RESTRICT,

  -- Razorpay's identifiers
  razorpay_order_id   text NOT NULL UNIQUE,  -- order_xxxxxx from /orders
  razorpay_payment_id text UNIQUE,           -- pay_xxxxxx, set after payment
  razorpay_signature  text,                  -- HMAC, for audit

  -- Money
  amount              numeric(10, 2) NOT NULL CHECK (amount > 0),
  currency            text NOT NULL DEFAULT 'INR',

  -- What this payment is for
  kind                razorpay_payment_kind NOT NULL,
  status              razorpay_payment_status NOT NULL DEFAULT 'created',

  -- Order link (only set when kind='order_payment').
  -- No FK because `orders` is partitioned.
  order_id            uuid,

  -- Razorpay's `notes` field — we stuff dealer code, intent, etc.
  notes               jsonb,

  -- Idempotency for webhook handling
  webhook_received    boolean NOT NULL DEFAULT false,

  -- Failure details (when status='failed')
  error_code          text,
  error_description   text,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  paid_at             timestamptz   -- set on transition to 'paid'
);

-- Sanity: order_payment must have order_id; credit_topup must not.
ALTER TABLE razorpay_payments
  ADD CONSTRAINT razorpay_payments_order_id_matches_kind
  CHECK (
    (kind = 'order_payment' AND order_id IS NOT NULL) OR
    (kind = 'credit_topup'  AND order_id IS NULL)
  );


-- ── 3. Indexes ──

-- Dealer's payment history (Profile screen, recent transactions list)
CREATE INDEX IF NOT EXISTS idx_razorpay_payments_dealer
  ON razorpay_payments (dealer_id, created_at DESC);

-- "Show me payment status for order X" (Indent's payment-required banner)
CREATE INDEX IF NOT EXISTS idx_razorpay_payments_order
  ON razorpay_payments (order_id)
  WHERE order_id IS NOT NULL;

-- Pending-payment cleanup job (Phase 3) — drops created/attempted rows
-- older than 24h that never got paid.
CREATE INDEX IF NOT EXISTS idx_razorpay_payments_status_age
  ON razorpay_payments (status, created_at)
  WHERE status IN ('created', 'attempted');


-- ════════════════════════════════════════════════════════════════════
-- Done. After this:
--   • razorpay_payments holds the Razorpay-side state of every
--     dealer-initiated payment.
--   • Existing tables (payments, dealer_ledger, orders) get their
--     rows on signature verification — same flow as admin receipts.
-- ════════════════════════════════════════════════════════════════════
