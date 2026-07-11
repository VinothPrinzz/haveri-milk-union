-- ════════════════════════════════════════════════════════════════════
-- Migration: 0035_fix_ledger_balance_after.sql
--
-- Why:
--   0023_backfill_credit_ledger.sql step 3 recomputed balance_after as:
--
--       window_sum(credits - debits over ALL rows)  +  opening_balance
--
--   But the window sum already includes the 'Opening' ledger row that
--   0015 seeded (which itself carries opening_balance as a credit/debit).
--   So opening_balance is counted twice for every row at/after the
--   Opening row, and the Opening row's own balance_after lands at
--   2 x opening_balance. This only affects dealers with a non-zero
--   opening balance, but for them the audit column is wrong.
--
--   Separately, some application insert paths wrote an incorrect
--   balance_after (e.g. the Razorpay top-up path hardcoded 0), so the
--   column is inconsistent regardless of the 0023 bug.
--
-- What this does:
--   One canonical recompute of balance_after for every dealer, using the
--   same definition the order-confirm path and the credit check use:
--
--       balance_after(row) = opening_balance
--                          + running sum of (credit +amt / debit -amt)
--                            over all NON-'Opening' rows up to this row
--
--   • The 'Opening' row contributes 0 to the running sum, so its own
--     balance_after = opening_balance (correct).
--   • opening_balance is added exactly once.
--   • Idempotent — only rows whose value actually changes are written,
--     so re-running is a no-op.
--
--   This supersedes 0023 step 3. Steps 1 and 2 of 0023 (inserting the
--   missing backfill debit/credit rows) remain valid and are untouched.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

WITH ordered AS (
  SELECT
    dl.id,
    COALESCE(d.opening_balance, 0)
      + COALESCE(
          SUM(
            CASE
              -- The Opening row already represents opening_balance,
              -- which we add explicitly above — so exclude it here.
              WHEN COALESCE(dl.voucher_type, '') = 'Opening' THEN 0
              WHEN dl.type = 'credit' THEN  dl.amount
              WHEN dl.type = 'debit'  THEN -dl.amount
              ELSE 0
            END
          ) OVER (
            PARTITION BY dl.dealer_id
            ORDER BY COALESCE(dl.voucher_date, dl.created_at::date),
                     dl.created_at,
                     dl.id
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
          ),
          0
        )
      AS new_balance_after
  FROM dealer_ledger dl
  JOIN dealers d ON d.id = dl.dealer_id
)
UPDATE dealer_ledger dl
SET balance_after = ordered.new_balance_after::numeric(12, 2)
FROM ordered
WHERE dl.id = ordered.id
  AND dl.balance_after IS DISTINCT FROM ordered.new_balance_after::numeric(12, 2);

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- Verification (run manually after applying):
--
--   -- The last row per dealer should equal the live closing-balance
--   -- formula used by checkDealerCredit / GET /api/v1/dealer/profile:
--   SELECT
--     d.id,
--     d.opening_balance
--       + COALESCE(SUM(CASE WHEN dl.type='credit' THEN dl.amount
--                           WHEN dl.type='debit'  THEN -dl.amount END)
--                  FILTER (WHERE COALESCE(dl.voucher_type,'') <> 'Opening'),
--                  0)                                  AS formula_balance,
--     (SELECT dl2.balance_after
--        FROM dealer_ledger dl2
--       WHERE dl2.dealer_id = d.id
--       ORDER BY COALESCE(dl2.voucher_date, dl2.created_at::date) DESC,
--                dl2.created_at DESC, dl2.id DESC
--       LIMIT 1)                                       AS last_row_balance
--   FROM dealers d
--   LEFT JOIN dealer_ledger dl ON dl.dealer_id = d.id
--   GROUP BY d.id, d.opening_balance
--   HAVING (SELECT dl2.balance_after FROM dealer_ledger dl2
--            WHERE dl2.dealer_id = d.id
--            ORDER BY COALESCE(dl2.voucher_date, dl2.created_at::date) DESC,
--                     dl2.created_at DESC, dl2.id DESC
--            LIMIT 1) IS DISTINCT FROM
--          d.opening_balance
--            + COALESCE(SUM(CASE WHEN dl.type='credit' THEN dl.amount
--                                WHEN dl.type='debit'  THEN -dl.amount END)
--                       FILTER (WHERE COALESCE(dl.voucher_type,'')<>'Opening'),
--                       0);
--
--   Zero rows returned == every dealer's ledger is internally consistent.
-- ════════════════════════════════════════════════════════════════════
