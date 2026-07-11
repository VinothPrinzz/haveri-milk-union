-- ════════════════════════════════════════════════════════════════════
-- Haveri Milk Union — Remove the HTM 500ML employee-subsidy rule
-- 0050_remove_htm500ml_employee_subsidy.sql
--
-- Why:
--   HTM 500ML should no longer be offered at the employee-subsidy rate.
--   The eligible-product list on Direct - Employee is driven entirely by
--   the ACTIVE rows in employee_subsidy_rules, so removing the rule drops
--   the product from that picker and blocks the POST .../employee-subsidy
--   eligibility check for it.
--
-- What:
--   Deactivate (rather than hard-delete) any active rule for the HTM 500ML
--   product. Deactivation preserves rule history and the prices already
--   snapshotted onto past sales; the partial unique index
--   uq_emp_subsidy_active_product is on (product_id) WHERE active = true,
--   so flipping active → false is always safe.
--
-- Note: HTM 500ML's products.code is the SKU 'PD0193' (the 'HTM-500ML'
-- string lives in products.report_alias, not code).
--
-- Idempotent — safe to re-run.
-- ════════════════════════════════════════════════════════════════════

UPDATE employee_subsidy_rules r
   SET active = false, updated_at = now()
  FROM products p
 WHERE p.id = r.product_id
   AND r.active = true
   AND p.code = 'PD0193';   -- HTM 500ML
