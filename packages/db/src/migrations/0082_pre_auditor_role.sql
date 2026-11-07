-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 0082: Pre-Auditor role
--
-- DTC Billing runs each month's contractor bills through
--   Prepared → Pre-audited → Marketing approved → Finance approved.
-- The pre-audit step gets its own login so the person who checks the bills
-- signs as "Pre-Auditor" on the printed sheet.
--
--   • pre_auditor → DTC Billing only: reads the bills and reports, and passes
--                   (or sends back) months waiting for pre-audit (dtc.audit).
--
-- NOTE: ALTER TYPE ... ADD VALUE is safe here (PG 12+) because the new value
-- is NOT used elsewhere in this migration. The login itself comes from the
-- user seed (see packages/db/src/seed-users.ts).
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'pre_auditor';
