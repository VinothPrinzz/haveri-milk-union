-- ════════════════════════════════════════════════════════════════════
-- Migration: 0023_backfill_credit_ledger.sql
--
-- Why:
--   Until the code change in 08c_credit_mode_ledger_patch.ts, only
--   wallet-mode orders wrote to dealer_ledger. Every historical
--   credit-mode order is therefore invisible to the new
--   credit_available calculation.
--
-- What this does:
--   1. Inserts one 'debit' / voucher_type='Invoice' ledger row per
--      historical credit-mode order that doesn't already have one.
--   2. Recomputes balance_after for the inserted rows (chronologically
--      per dealer) so the ledger remains internally consistent.
--   3. Idempotent — safe to re-run.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- 1. Insert missing debit rows for historical credit orders.
-- Use ON CONFLICT-style WHERE NOT EXISTS so re-running is a no-op.

INSERT INTO dealer_ledger
  (dealer_id, type, amount, reference_id, reference_type,
   voucher_type, voucher_date,
   description, balance_after, created_at)
SELECT
  o.dealer_id,
  'debit',
  o.grand_total::numeric,
  o.id,
  'order',
  'Invoice',
  COALESCE(o.created_at::date, now()::date),
  'Backfill: credit indent ' || o.id,
  0,                            -- placeholder; recomputed below
  COALESCE(o.created_at, now())
FROM orders o
WHERE o.payment_mode = 'credit'
  AND o.status <> 'cancelled'
  AND NOT EXISTS (
    SELECT 1 FROM dealer_ledger dl
    WHERE dl.reference_type = 'order'
      AND dl.reference_id   = o.id
      AND dl.type           = 'debit'
  );

-- 2. Insert reversal credits for historical credit orders that were
--    cancelled — these need to net to zero in the ledger.

INSERT INTO dealer_ledger
  (dealer_id, type, amount, reference_id, reference_type,
   voucher_type, voucher_date,
   description, balance_after, created_at)
SELECT
  o.dealer_id,
  'credit',
  o.grand_total::numeric,
  o.id,
  'order',
  'Adjustment',
  COALESCE(o.cancelled_at::date, o.updated_at::date, now()::date),
  'Backfill: cancel credit indent ' || o.id,
  0,
  COALESCE(o.cancelled_at, o.updated_at, now())
FROM orders o
WHERE o.payment_mode = 'credit'
  AND o.status = 'cancelled'
  AND NOT EXISTS (
    SELECT 1 FROM dealer_ledger dl
    WHERE dl.reference_type = 'order'
      AND dl.reference_id   = o.id
      AND dl.type           = 'credit'
  )
  -- only insert the credit reversal if a debit exists (matching pair)
  AND EXISTS (
    SELECT 1 FROM dealer_ledger dl
    WHERE dl.reference_type = 'order'
      AND dl.reference_id   = o.id
      AND dl.type           = 'debit'
  );

-- 3. Recompute balance_after across the entire ledger per dealer.
-- This is a one-shot fixup, since the balance_after column is
-- normally maintained by the application transaction.

WITH ordered AS (
  SELECT
    dl.id,
    dl.dealer_id,
    SUM(
      CASE WHEN dl.type = 'credit' THEN  dl.amount
           WHEN dl.type = 'debit'  THEN -dl.amount
           ELSE 0 END
    ) OVER (
      PARTITION BY dl.dealer_id
      ORDER BY COALESCE(dl.voucher_date, dl.created_at::date),
               dl.created_at,
               dl.id
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    )
    + COALESCE((SELECT d.opening_balance FROM dealers d WHERE d.id = dl.dealer_id), 0)
    AS new_balance_after
  FROM dealer_ledger dl
)
UPDATE dealer_ledger dl
SET balance_after = ordered.new_balance_after::numeric
FROM ordered
WHERE dl.id = ordered.id
  AND dl.balance_after IS DISTINCT FROM ordered.new_balance_after::numeric;

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- After running this, GET /api/v1/dealers should show realistic
-- `outstanding` and `credit_available` values for every dealer
-- who placed credit orders before the code change.
-- ════════════════════════════════════════════════════════════════════
