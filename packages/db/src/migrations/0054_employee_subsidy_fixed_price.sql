-- ════════════════════════════════════════════════════════════════════
-- Haveri Milk Union — Employee subsidy is now a FIXED price, not a %
-- 0054_employee_subsidy_fixed_price.sql
--
-- Why:
--   The employee-subsidy price (e.g. Ghee 500ml UTP) is NOT a fixed
--   percentage off the dealer/MRP price — it is a UTP rate set by hand.
--   So the percentage model (base_price × (1 − subsidy%)) is replaced by a
--   single editable column holding the GST-INCLUSIVE price the employee
--   pays per unit. Staff set this on the Employees master page.
--
-- What:
--   1. Add employee_subsidy_rules.subsidy_price (GST-inclusive unit price).
--   2. Backfill it from the legacy percent formula so existing rules keep
--      their effective price. base_price is GST-EXCLUSIVE, so the final
--      (GST-inclusive) price the employee pays is
--        base_price × (1 − subsidy%/100) × (1 + gst%/100).
--   3. Make subsidy_price NOT NULL (the new source of truth) and
--      subsidy_percent nullable (kept only for history).
--
-- Idempotent — safe to re-run.
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE employee_subsidy_rules
  ADD COLUMN IF NOT EXISTS subsidy_price numeric(12, 2);

-- Backfill the GST-inclusive employee price from the legacy percent formula.
UPDATE employee_subsidy_rules r
   SET subsidy_price = ROUND(
         p.base_price
         * (1 - COALESCE(r.subsidy_percent, 0) / 100.0)
         * (1 + COALESCE(p.gst_percent, 0) / 100.0), 2)
  FROM products p
 WHERE p.id = r.product_id
   AND r.subsidy_price IS NULL;

-- Any orphaned rule (FK should prevent this) → 0 so the NOT NULL below holds.
UPDATE employee_subsidy_rules
   SET subsidy_price = 0
 WHERE subsidy_price IS NULL;

ALTER TABLE employee_subsidy_rules
  ALTER COLUMN subsidy_price SET NOT NULL;

-- A fixed price drives pricing now; percent is no longer required.
ALTER TABLE employee_subsidy_rules
  ALTER COLUMN subsidy_percent DROP NOT NULL;

-- Non-negative price guard (guarded so re-runs don't error on duplicate).
DO $$ BEGIN
  ALTER TABLE employee_subsidy_rules
    ADD CONSTRAINT chk_emp_subsidy_price_nonneg CHECK (subsidy_price >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN employee_subsidy_rules.subsidy_price IS
  'GST-inclusive unit price the employee pays. Source of truth for employee-subsidy pricing (replaces subsidy_percent).';
