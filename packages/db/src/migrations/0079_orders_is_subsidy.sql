-- ════════════════════════════════════════════════════════════════════
-- Haveri Milk Union — standalone subsidy orders
-- 0079_orders_is_subsidy.sql
--
-- Why:
--   The Subsidy Indents page used to write its HTM 1000ML (sub) line onto
--   the customer's existing order for the day (draft or placed). The desk
--   wants each subsidy indent to be its OWN confirmed order instead,
--   leaving the regular indent alone.
--
--   Several lookups pick "the dealer's latest live order for the date"
--   (dealer app, Record Indents, auto-confirm, nightly drafts). A separate
--   subsidy order would hijack them — e.g. auto-confirm would see it and
--   skip the real draft. This flag lets those lookups pass it by.
--
-- What:
--   orders.is_subsidy boolean NOT NULL DEFAULT false. Constant default, so
--   adding it is metadata-only (no table rewrite). Existing rows are false:
--   past subsidy lines were appended onto regular orders.
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS is_subsidy boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN orders.is_subsidy IS
  'True for a standalone order placed from the Subsidy Indents page. Skipped by every "the day''s order" lookup.';
