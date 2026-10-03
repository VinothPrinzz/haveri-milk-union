-- ═══════════════════════════════════════════════════════════════════════
-- 0071_direct_sales_cancellation.sql
--
-- Gives direct_sales a cancellation state, so a counter sale or agent gate
-- pass can be cancelled the way an indent is (orders.status = 'cancelled')
-- instead of being deleted row-by-row by hand.
--
-- Until now direct_sales had no status / cancelled_at / deleted_at at all:
-- the only way to stop a mistaken sale counting as revenue in Recent Sales,
-- the Day Book, the sales reports, the Gate Pass Report and the Dispatch
-- Sheet was to DELETE it (and its razorpay_payments QR row, which is
-- ON DELETE RESTRICT). That destroys the record of what happened.
--
-- Every read site that books a sale now filters on status = 'confirmed'.
-- Existing rows are all live sales, so they default to 'confirmed'.
--
-- No enum: a plain text column with a CHECK keeps this reversible and
-- avoids an ALTER TYPE, which cannot run inside the same transaction as
-- the statements that use the new value.
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE direct_sales
  ADD COLUMN IF NOT EXISTS status              text NOT NULL DEFAULT 'confirmed',
  ADD COLUMN IF NOT EXISTS cancelled_at        timestamptz,
  ADD COLUMN IF NOT EXISTS cancellation_reason text,
  ADD COLUMN IF NOT EXISTS cancelled_by        uuid;

ALTER TABLE direct_sales DROP CONSTRAINT IF EXISTS direct_sales_status_chk;
ALTER TABLE direct_sales
  ADD CONSTRAINT direct_sales_status_chk
  CHECK (status IN ('confirmed', 'cancelled'));

-- A cancelled sale must say when and why. Mirrors the audit trail an
-- order keeps (cancelled_at + cancellation_reason).
ALTER TABLE direct_sales DROP CONSTRAINT IF EXISTS direct_sales_cancel_shape_chk;
ALTER TABLE direct_sales
  ADD CONSTRAINT direct_sales_cancel_shape_chk
  CHECK (
    status <> 'cancelled'
    OR (cancelled_at IS NOT NULL AND cancellation_reason IS NOT NULL)
  );

ALTER TABLE direct_sales DROP CONSTRAINT IF EXISTS direct_sales_cancelled_by_fkey;
ALTER TABLE direct_sales
  ADD CONSTRAINT direct_sales_cancelled_by_fkey
  FOREIGN KEY (cancelled_by) REFERENCES users(id) ON DELETE SET NULL;

-- Cancelled sales are the rare case; a partial index keeps the common
-- "status = 'confirmed'" filter cheap without carrying a full-table index.
CREATE INDEX IF NOT EXISTS idx_direct_sales_cancelled
  ON direct_sales (sale_date)
  WHERE status = 'cancelled';

-- ── Invoices for counter sales ───────────────────────────────────────
-- A direct sale can now mint a tax invoice, so the bill # on Recent Sales
-- opens a real document instead of falling back to the modify screen.
--
-- invoices_party_chk (migration 0062) demanded EXACTLY one ledger party:
--   CHECK (num_nonnulls(dealer_id, employee_id) = 1)
-- An agent gate pass satisfies it — its customer_id IS a dealer. A cash
-- counter sale has neither: the buyer is a cash_customers row or a walk-in,
-- with no ledger of their own. Relaxed to "at most one" so those can be
-- invoiced too. dealer_name is NOT NULL and still carries the party name for
-- every kind, which is what the PDF header and the invoice reports read, so
-- nothing downstream sees an unnamed party.
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_party_chk;
ALTER TABLE invoices
  ADD CONSTRAINT invoices_party_chk
  CHECK (num_nonnulls(dealer_id, employee_id) <= 1);
