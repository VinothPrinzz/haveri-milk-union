-- ════════════════════════════════════════════════════════════════════
-- Haveri Milk Union — one receipt settles many invoices
-- 0076_payment_allocations.sql
--
-- Why:
--   Record Payment could only link a receipt to ONE invoice
--   (payments.invoice_id). Dealers routinely pay several bills with one
--   cheque / transfer, and AR Aging reads invoices.paid_amount — so any
--   invoice not linked kept showing as due.
--
-- What:
--   • payment_allocations — how much of a payment was applied to each
--     invoice. POST /payments writes one row per settled invoice and bumps
--     invoices.paid_amount by the same amount; cheque cancel/bounce walks
--     these rows to roll each invoice back.
--   • payments.invoice_id stays (set when a receipt settles exactly one
--     invoice) so existing readers keep working.
--   • Backfill: every existing invoice-linked payment gets one allocation
--     for its full amount — exactly what was added to paid_amount at the
--     time, so cheque reversals of old receipts behave as before.
--
-- Idempotent — CREATE IF NOT EXISTS + NOT EXISTS-guarded backfill.
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS payment_allocations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id  uuid NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  invoice_id  uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  amount      numeric(12, 2) NOT NULL CHECK (amount > 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payment_id, invoice_id)
);

CREATE INDEX IF NOT EXISTS idx_payment_allocations_invoice
  ON payment_allocations (invoice_id);

INSERT INTO payment_allocations (payment_id, invoice_id, amount, created_at)
SELECT p.id, p.invoice_id, p.amount, p.created_at
  FROM payments p
 WHERE p.invoice_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM payment_allocations pa
      WHERE pa.payment_id = p.id AND pa.invoice_id = p.invoice_id
   );
