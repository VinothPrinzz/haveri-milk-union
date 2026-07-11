-- ══════════════════════════════════════════════════════════════════
-- Haveri Milk Union — Manual Adjustments Migration
-- 0042_ledger_adjustments.sql
--
-- Adds first-class support for finance-initiated credit notes,
-- debit notes, write-offs, and reversals. Until now these only
-- existed as side-effects of other flows.
--
-- Strategy:
--   • Extend dealer_ledger.voucher_type check to include the new
--     voucher types ('Credit Note', 'Debit Note', 'Write-off').
--     'Adjustment' is retained for SYSTEM-generated entries
--     (cheque bounce reversal, order cancel reversal) so the
--     audit story stays clean: operator-initiated vs system.
--   • New sidecar table ledger_adjustments — 1:1 with the
--     dealer_ledger row — carries reason category, optional
--     invoice/order link, attachment URL, reversal back-pointer.
--   • No changes to existing data. Backfill is not needed because
--     historical 'Adjustment' rows are correctly system-generated.
-- ══════════════════════════════════════════════════════════════════

-- 1. Expand voucher_type check (originally set in 0015).
ALTER TABLE dealer_ledger
  DROP CONSTRAINT IF EXISTS dealer_ledger_voucher_type_check;

ALTER TABLE dealer_ledger
  ADD CONSTRAINT dealer_ledger_voucher_type_check
  CHECK (voucher_type IS NULL OR voucher_type IN (
    'Invoice','Receipt','Adjustment','Opening','Refund',
    'Credit Note','Debit Note','Write-off'
  ));


-- 2. Reason category enum.
DO $$ BEGIN
  CREATE TYPE adjustment_reason AS ENUM (
    'sale_return',         -- dealer returned product
    'billing_error',       -- invoice was wrong (price, qty, tax)
    'goodwill',            -- discretionary credit
    'damaged_goods',       -- compensation for damage
    'rate_difference',     -- price was revised retroactively
    'late_fee',            -- finance charge for overdue
    'interest',            -- interest on outstanding
    'bounce_charges',      -- bank charges recovered
    'missed_billing',      -- previously un-billed delivery
    'write_off',           -- uncollectible
    'reversal',            -- undoing a prior entry
    'other'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- 3. Sidecar metadata table.
CREATE TABLE IF NOT EXISTS ledger_adjustments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ledger_entry_id    uuid NOT NULL UNIQUE
                     REFERENCES dealer_ledger(id) ON DELETE RESTRICT,
  dealer_id          uuid NOT NULL
                     REFERENCES dealers(id) ON DELETE RESTRICT,

  voucher_type       text NOT NULL,                       -- mirrors dealer_ledger.voucher_type
  reason             adjustment_reason NOT NULL,
  reason_text        text NOT NULL,                       -- free-text required, audited

  -- Optional links to source documents.
  invoice_id         uuid REFERENCES invoices(id) ON DELETE SET NULL,
  order_id           uuid,                                 -- not FK (orders is partitioned)
  attachment_url     text,                                 -- R2 / S3 link to support doc

  -- Reversal back-pointer: when this adjustment IS a reversal,
  -- which entry does it reverse?
  reverses_ledger_entry_id uuid
                     REFERENCES dealer_ledger(id) ON DELETE SET NULL,

  -- Audit.
  initiated_by       uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  approved_by        uuid REFERENCES users(id) ON DELETE SET NULL,   -- optional dual-approval
  approved_at        timestamptz,

  created_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT adj_voucher_type_check CHECK (
    voucher_type IN ('Credit Note','Debit Note','Write-off')
  )
);

CREATE INDEX IF NOT EXISTS idx_ledger_adj_dealer_created
  ON ledger_adjustments (dealer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_adj_reason
  ON ledger_adjustments (reason);
CREATE INDEX IF NOT EXISTS idx_ledger_adj_invoice
  ON ledger_adjustments (invoice_id)
  WHERE invoice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ledger_adj_reverses
  ON ledger_adjustments (reverses_ledger_entry_id)
  WHERE reverses_ledger_entry_id IS NOT NULL;
