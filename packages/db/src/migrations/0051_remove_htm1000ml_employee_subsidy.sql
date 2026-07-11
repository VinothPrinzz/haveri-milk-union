-- ════════════════════════════════════════════════════════════════════
-- Haveri Milk Union — Remove the HTM 1000ML employee-subsidy rule
-- 0051_remove_htm1000ml_employee_subsidy.sql
--
-- Why:
--   HTM 1000ML should no longer be offered at the employee-subsidy rate.
--   The eligible-product list on Direct - Employee is driven entirely by
--   the ACTIVE rows in employee_subsidy_rules, so removing the rule drops
--   the product from that picker and blocks the POST .../employee-subsidy
--   eligibility check for it. Companion to 0050 (HTM 500ML).
--
-- What:
--   Deactivate (rather than hard-delete) any active rule for the HTM 1000ML
--   product. Deactivation preserves rule history and the prices already
--   snapshotted onto past sales; the partial unique index
--   uq_emp_subsidy_active_product is on (product_id) WHERE active = true,
--   so flipping active → false is always safe.
--
-- Note: HTM 1000ML's products.code is the SKU 'PD0191' (the 'HTM-1000ML'
-- string lives in products.report_alias, not code).
--
-- Idempotent — safe to re-run.
-- ════════════════════════════════════════════════════════════════════

UPDATE employee_subsidy_rules r
   SET active = false, updated_at = now()
  FROM products p
 WHERE p.id = r.product_id
   AND r.active = true
   AND p.code = 'PD0191';   -- HTM 1000ML
