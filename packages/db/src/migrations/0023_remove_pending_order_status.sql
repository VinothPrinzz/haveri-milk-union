-- ═══════════════════════════════════════════════════════════════════════
-- Migration 0023 — Remove "pending" from order status flow
--
-- BACKGROUND
-- The "Post Indent" web page (PostIndentPage) was the only mechanism for
-- manually moving orders from 'pending' → 'confirmed'. That page has been
-- removed because route-sheets auto-generate from confirmed orders.
-- Without it, 'pending' is a dead-end state that orders would never leave.
--
-- NEW LIFECYCLE
--   draft → confirmed (dealer/admin confirms, or window auto-closes)
--         → dispatched → delivered
--   draft → payment_required (credit insufficient)
--   any   → cancelled
--
-- WHAT THIS MIGRATION DOES
--   1. Migrates any existing 'pending' orders to 'confirmed' so they
--      re-enter the active dispatch pipeline immediately.
--   2. Fixes the orders table column DEFAULT from 'pending' to 'draft'
--      (all inserts already set status explicitly, this is belt-and-braces).
--
-- NOTE ON ENUM VALUE
--   PostgreSQL does not allow removing a value from an existing enum type
--   without a full type rebuild (CREATE TYPE ... AS ENUM, ALTER COLUMN,
--   DROP TYPE). Because the orders table is partitioned, this is even more
--   complex and risky. The 'pending' enum value is therefore KEPT in the
--   DB enum definition but will no longer be written by any application
--   code. It is effectively deprecated.
--   If you want to clean it up in a future low-traffic maintenance window,
--   see the optional block at the bottom of this file.
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;

-- ── Step 1: Migrate existing 'pending' orders → 'confirmed' ──────────
-- These are orders that were confirmed by a dealer (credit OK) but never
-- "posted" via PostIndentPage. They are legitimate confirmed orders.
UPDATE orders
   SET status     = 'confirmed',
       updated_at = now()
 WHERE status = 'pending';

-- ── Step 2: Fix the column DEFAULT (was 'pending', should be 'draft') ─
-- Only affects edge-case INSERT statements that omit the status column.
-- All normal inserts (API + worker) set status explicitly to 'draft'.
ALTER TABLE orders ALTER COLUMN status SET DEFAULT 'draft';

COMMIT;


-- ═══════════════════════════════════════════════════════════════════════
-- OPTIONAL: Full enum cleanup (run separately, during maintenance window)
--
-- WARNING: The orders table is RANGE PARTITIONED. Rebuilding the enum
-- requires altering EVERY partition. Test on staging first.
--
-- -- Verify no rows use 'pending' before proceeding:
-- SELECT COUNT(*) FROM orders WHERE status = 'pending';  -- must be 0
--
-- -- Rebuild enum without 'pending':
-- CREATE TYPE order_status_new AS ENUM (
--   'draft', 'payment_required', 'confirmed',
--   'dispatched', 'delivered', 'cancelled'
-- );
--
-- -- Alter all partitions (repeat for each orders_YYYY_MM partition):
-- ALTER TABLE orders
--   ALTER COLUMN status TYPE order_status_new
--   USING status::text::order_status_new;
--
-- DROP TYPE order_status;
-- ALTER TYPE order_status_new RENAME TO order_status;
-- ═══════════════════════════════════════════════════════════════════════
