-- ════════════════════════════════════════════════════════════════════
-- Haveri Milk Union — Supplier purchase ledger
-- 0087_supplier_ledger.sql
--
-- Why:
--   Purchases from suppliers are recorded (stock_receipts, with the unit
--   cost snapshot), but nothing recorded what the union paid them, so there
--   was no per-supplier ledger of what is owed.
--
-- What:
--   • supplier_ledger_entries — everything on a supplier's ledger that is
--     not a purchase: payments made, an opening balance, debit notes
--     (returns, short / damaged supply deducted) and credit notes. Purchases
--     themselves are read live from stock_receipts, so editing a receipt in
--     Stock Entry is reflected at once.
--
--   Balance = what the union owes the supplier (Cr):
--     opening + purchases + credit notes − payments − debit notes
--
--   Entries are never deleted: a mistaken one is cancelled with a reason
--   (cancelled_at), which takes it off the ledger.
--
-- Idempotent.
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS supplier_ledger_entries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id   uuid NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  entry_date    date NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('payment', 'opening', 'debit_note', 'credit_note')),
  amount        numeric(14, 2) NOT NULL CHECK (amount > 0),
  -- Payments: neft / rtgs / imps / upi / cheque / cash
  mode          text,
  reference     text,
  notes         text,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  cancelled_at  timestamptz,
  cancelled_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  cancel_reason text
);
CREATE INDEX IF NOT EXISTS idx_supplier_ledger_entries_supplier
  ON supplier_ledger_entries (supplier_id, entry_date) WHERE cancelled_at IS NULL;
