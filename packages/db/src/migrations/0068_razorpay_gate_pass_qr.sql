-- ════════════════════════════════════════════════════════════════════
-- 0068 — razorpay_payments can hold a gate-pass counter QR payment
--
-- Gate-pass sales (direct_sales where customer_type = 'agent') are paid
-- at the office counter. Today the operator types the UPI reference into
-- direct_sales.payment_ref by hand — see the paymentRef requirement in
-- apps/api/src/routes/direct-sales.ts — which is the step this makes
-- unnecessary: a per-sale Razorpay QR carries the sale id in its notes,
-- and the qr_code.credited webhook stamps the reference itself.
--
-- What actually blocked it was razorpay_order_id NOT NULL. A QR payment
-- has no Razorpay order at all — the customer scans a qr_xxx, and the
-- credited event's payment entity carries order_id: null. The kind
-- <-> order_id CHECK from 0032 also admitted exactly two shapes.
--
-- dealer_id deliberately STAYS NOT NULL. A gate-pass agent is a row in
-- `dealers` (direct_sales.customer_id is polymorphic, and the 'agent'
-- branch joins dealers — see direct-sales.ts and finance-day-book.ts),
-- so every gate-pass payment has a real dealer to hang off. Keeping it
-- means Finance > Online Payments and the reconciliation report keep
-- their existing INNER JOIN to dealers and show the agent's name with no
-- change at all.
--
-- Note on the UNIQUE on razorpay_order_id: it stays. Postgres treats
-- NULLs as distinct in a unique index, so any number of gate-pass rows
-- can sit there with a NULL order id.
--
-- Deliberately NOT done here: gate-pass money does not write a `payments`
-- row or a dealer_ledger credit, even though it now has a dealer_id to do
-- it with. That is the existing, intentional model, not an oversight —
-- finance-day-book.ts:231 puts it plainly: counter sales' "cash never
-- enters `payments`, so they count toward sales but not receipts", and
-- the sale is already booked at its grand_total in direct_sales. Posting
-- a receipt here would double-count the money and hand the agent a
-- dealer_ledger credit they never earned. applyPaidPayment() branches on
-- kind so the dealer path never runs for these.
--
-- The reconciliation orphan sweep excludes them for the same reason:
-- "paid row with no payments row" is the NORMAL and permanent state of a
-- gate-pass payment, not a fault to heal.
--
-- Pre-flight (expect 0 rows; anything returned would fail the new CHECK):
--   SELECT id, kind, dealer_id, razorpay_order_id, order_id
--     FROM razorpay_payments
--    WHERE dealer_id IS NULL
--       OR razorpay_order_id IS NULL
--       OR (kind = 'order_payment' AND order_id IS NULL)
--       OR (kind = 'credit_topup'  AND order_id IS NOT NULL);
-- ════════════════════════════════════════════════════════════════════

-- ── 1. A QR payment has no Razorpay order ───────────────────────────
ALTER TABLE razorpay_payments
  ALTER COLUMN razorpay_order_id DROP NOT NULL;

-- ── 2. The gate-pass columns ────────────────────────────────────────
-- The QR id is the ONLY handle the qr_code.credited webhook can look a
-- row up by: that payload identifies the QR (payload.qr_code.entity.id)
-- and the payment, never an order.
ALTER TABLE razorpay_payments
  ADD COLUMN IF NOT EXISTS razorpay_qr_code_id text;

-- RESTRICT, not CASCADE: a paid gate pass must never be able to delete
-- the record of the money that paid for it.
ALTER TABLE razorpay_payments
  ADD COLUMN IF NOT EXISTS direct_sale_id uuid
    REFERENCES direct_sales(id) ON DELETE RESTRICT;

-- Partial unique: one row per QR, and no NULL rows in the index at all.
CREATE UNIQUE INDEX IF NOT EXISTS idx_razorpay_payments_qr_code
  ON razorpay_payments (razorpay_qr_code_id)
  WHERE razorpay_qr_code_id IS NOT NULL;

-- The counter screen polls "is this sale paid yet", which is a lookup by
-- sale. Partial for the same reason as above.
CREATE INDEX IF NOT EXISTS idx_razorpay_payments_direct_sale
  ON razorpay_payments (direct_sale_id)
  WHERE direct_sale_id IS NOT NULL;

-- ── 3. One CHECK describing all three shapes ────────────────────────
-- Replaces razorpay_payments_order_id_matches_kind from 0032. Renamed
-- because it now constrains direct_sale_id and the QR id too, and the
-- old name would be a lie.
ALTER TABLE razorpay_payments
  DROP CONSTRAINT IF EXISTS razorpay_payments_order_id_matches_kind;

ALTER TABLE razorpay_payments
  DROP CONSTRAINT IF EXISTS razorpay_payments_shape_matches_kind;

ALTER TABLE razorpay_payments
  ADD CONSTRAINT razorpay_payments_shape_matches_kind CHECK (
    (kind = 'credit_topup'
      AND razorpay_order_id   IS NOT NULL
      AND order_id            IS NULL
      AND direct_sale_id      IS NULL
      AND razorpay_qr_code_id IS NULL)
    OR
    (kind = 'order_payment'
      AND razorpay_order_id   IS NOT NULL
      AND order_id            IS NOT NULL
      AND direct_sale_id      IS NULL
      AND razorpay_qr_code_id IS NULL)
    OR
    (kind = 'gate_pass'
      AND razorpay_order_id   IS NULL
      AND order_id            IS NULL
      AND direct_sale_id      IS NOT NULL
      AND razorpay_qr_code_id IS NOT NULL)
  );
