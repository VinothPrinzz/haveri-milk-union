-- ════════════════════════════════════════════════════════════════════
-- One-off correction: reverse duplicate "Gate pass … revised down" credits
-- (run once in the Supabase SQL editor; safe to re-run — it skips any
--  gate pass that already has a correction row)
--
-- Cause: ledgerPostedForSale ignored 'adjustment' rows, so the SECOND edit
-- of a gate pass re-credited the first cut (fixed in the same commit as
-- this file).
--
--   GP-0532  S118 SATISH JADAR  first cut ₹2,062.50 credited twice
--   GP-0531  R53  RAJU DASAR    first cut ₹1,339.27 credited twice
--
-- The rows are plain dealer_ledger debits (reference_type 'order',
-- voucher_type 'Adjustment', no voucher_no, no ledger_adjustments row), so
-- they move the balance the order check reads but do NOT appear on the
-- Dealer Statement or Day Book — those were already correct because they
-- are built from invoice amounts.
-- ════════════════════════════════════════════════════════════════════
BEGIN;

INSERT INTO dealer_ledger
  (dealer_id, type, amount, reference_id, reference_type,
   voucher_type, voucher_date, description, balance_after, performed_by)
SELECT
  v.dealer_id,
  'debit'::ledger_type,
  v.amount,
  v.sale_id,
  'order'::ledger_ref_type,
  'Adjustment',
  (now() AT TIME ZONE 'Asia/Kolkata')::date,
  'Gate pass ' || v.gp_no || ' correction: reverse duplicate revised-down credit '
    || '(first cut of ₹' || v.amount || ' was credited twice on 11-11-2026)',
  ( SELECT COALESCE(d.opening_balance, 0)
         + COALESCE((SELECT SUM(CASE WHEN dl.type = 'credit' THEN dl.amount
                                     ELSE -dl.amount END)
                       FROM dealer_ledger dl
                      WHERE dl.dealer_id = d.id
                        AND COALESCE(dl.voucher_type, '') <> 'Opening'), 0)
      FROM dealers d WHERE d.id = v.dealer_id ) - v.amount,
  NULL
FROM (VALUES
  ('50447230-db5d-40c0-aa05-7e09f228359b'::uuid,
   'c991b86f-99c1-47d2-932b-7eceea8f8caa'::uuid, 'GP-0532', 2062.50::numeric),
  ('2167f7c5-c5f8-4732-8ed8-f8742703c604'::uuid,
   '2bcf2a3d-4aa2-4575-8f47-9e7425b500f9'::uuid, 'GP-0531', 1339.27::numeric)
) AS v(dealer_id, sale_id, gp_no, amount)
WHERE NOT EXISTS (
  SELECT 1 FROM dealer_ledger x
   WHERE x.reference_id = v.sale_id
     AND x.description LIKE 'Gate pass % correction:%'
)
RETURNING dealer_id, amount, balance_after, description;

-- Check: each gate pass's net ledger posting now equals its grand total.
SELECT ds.gp_no, ds.grand_total,
       SUM(CASE WHEN dl.type = 'debit' THEN dl.amount ELSE -dl.amount END) AS ledger_net
  FROM direct_sales ds
  JOIN dealer_ledger dl ON dl.reference_id = ds.id
 WHERE ds.gp_no IN ('GP-0531', 'GP-0532')
 GROUP BY ds.gp_no, ds.grand_total;
-- Expect: GP-0531 42677.40 / 42677.40, GP-0532 4075.42 / 4075.42

COMMIT;
