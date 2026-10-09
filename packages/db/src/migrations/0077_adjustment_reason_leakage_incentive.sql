-- ════════════════════════════════════════════════════════════════════
-- 0077 — adjustment_reason gains 'leakage_incentive'
--
-- Split from 0078 for the same reason as 0067: PostgreSQL refuses to USE
-- a new enum value in the transaction that ADDed it, and migrate.ts runs
-- each file in one transaction. Keep this file to the ALTER TYPE alone.
--
-- Credit notes posted by a Milk Leakage Incentive run carry this reason,
-- so they stay distinguishable from hand-issued credit notes on
-- Finance → Credit/Debit Notes and in the dealer ledger.
-- ════════════════════════════════════════════════════════════════════

ALTER TYPE adjustment_reason ADD VALUE IF NOT EXISTS 'leakage_incentive';
