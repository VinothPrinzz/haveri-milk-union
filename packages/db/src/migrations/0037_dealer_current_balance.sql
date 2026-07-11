-- ════════════════════════════════════════════════════════════════════
-- Haveri Milk Union — Stored Dealer Credit Balance
-- 0037_dealer_current_balance.sql
--
-- Why:
--   checkDealerCredit() and the dealer profile / dealer list endpoints
--   all recompute the dealer's running balance on every call:
--
--       opening_balance + SUM(credits) - SUM(debits)   over dealer_ledger
--
--   That is a full scan of the dealer's ledger history per request.
--   This migration materialises that value into dealers.current_balance
--   so reads become a single column fetch.
--
-- What:
--   1. dealers.current_balance numeric(12,2) NOT NULL DEFAULT 0
--   2. Backfill from the existing ledger (insertion-order independent).
--   3. AFTER INSERT trigger on dealer_ledger keeps it in sync forever.
--
-- Design note — why a trigger, not app code:
--   dealer_ledger is APPEND-ONLY and is written from ~8 different code
--   paths (wallet order debit, credit order debit, finance receipts,
--   order-modify adjustments, opening-balance seeds, worker auto-confirm,
--   refunds...). A trigger guarantees current_balance can never drift,
--   regardless of which path inserts the row. No UPDATE/DELETE trigger
--   is needed because the table is never updated or deleted.
--
-- Consistency guarantee:
--   current_balance is defined as SUM(signed amount) over ALL ledger
--   rows — INCLUDING the 'Opening' voucher row, whose amount already
--   equals the dealer's opening_balance (seeded in 0015). Therefore:
--
--       current_balance  ==  opening_balance
--                            + SUM(credit-debit WHERE voucher_type<>'Opening')
--
--   ...which is EXACTLY the closing_balance formula checkDealerCredit
--   uses today. Dealers with opening_balance = 0 have no Opening row,
--   so their current_balance correctly starts at 0.
--
-- Idempotent — safe to re-run.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Add the column ────────────────────────────────────────────────
ALTER TABLE dealers
  ADD COLUMN IF NOT EXISTS current_balance numeric(12, 2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN dealers.current_balance IS
  'Materialised running ledger balance. Maintained by trg_dealer_ledger_balance. '
  'Equals opening_balance + net of all non-Opening ledger rows. '
  'A negative value means the dealer owes the union (outstanding).';


-- ── 2. Backfill from the existing ledger ─────────────────────────────
-- SUM over ALL rows (Opening row included) is insertion-order
-- independent, so no window function is required here.
UPDATE dealers d
SET current_balance = COALESCE(agg.bal, 0)::numeric(12, 2)
FROM (
  SELECT
    dl.dealer_id,
    SUM(CASE WHEN dl.type = 'credit' THEN  dl.amount
             WHEN dl.type = 'debit'  THEN -dl.amount
             ELSE 0 END) AS bal
  FROM dealer_ledger dl
  GROUP BY dl.dealer_id
) AS agg
WHERE agg.dealer_id = d.id
  AND d.current_balance IS DISTINCT FROM COALESCE(agg.bal, 0)::numeric(12, 2);

-- Dealers with zero ledger rows keep the DEFAULT 0 — nothing to do.


-- ── 3. Maintenance trigger ───────────────────────────────────────────
-- Fires once per inserted ledger row and applies the signed delta to
-- the dealer's stored balance. Because dealer_ledger is append-only
-- this single AFTER INSERT trigger is sufficient.
CREATE OR REPLACE FUNCTION fn_dealer_ledger_apply_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE dealers
  SET current_balance = current_balance
        + CASE WHEN NEW.type = 'credit' THEN  NEW.amount
               WHEN NEW.type = 'debit'  THEN -NEW.amount
               ELSE 0 END,
      updated_at = now()
  WHERE id = NEW.dealer_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_dealer_ledger_balance ON dealer_ledger;

CREATE TRIGGER trg_dealer_ledger_balance
  AFTER INSERT ON dealer_ledger
  FOR EACH ROW
  EXECUTE FUNCTION fn_dealer_ledger_apply_balance();

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- Verification (run manually after applying):
--
--   -- Every dealer's stored balance must equal the live formula.
--   SELECT d.id, d.code, d.current_balance,
--          d.opening_balance
--            + COALESCE(SUM(CASE WHEN dl.type='credit' THEN  dl.amount
--                                WHEN dl.type='debit'  THEN -dl.amount END)
--                       FILTER (WHERE COALESCE(dl.voucher_type,'')<>'Opening'),
--                       0) AS formula_balance
--   FROM dealers d
--   LEFT JOIN dealer_ledger dl ON dl.dealer_id = d.id
--   GROUP BY d.id, d.code, d.current_balance, d.opening_balance
--   HAVING d.current_balance IS DISTINCT FROM
--          d.opening_balance
--            + COALESCE(SUM(CASE WHEN dl.type='credit' THEN  dl.amount
--                                WHEN dl.type='debit'  THEN -dl.amount END)
--                       FILTER (WHERE COALESCE(dl.voucher_type,'')<>'Opening'),
--                       0);
--
--   Zero rows returned == every dealer's stored balance is correct.
-- ════════════════════════════════════════════════════════════════════
