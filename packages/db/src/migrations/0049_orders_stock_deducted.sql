-- ════════════════════════════════════════════════════════════════════
-- Haveri Milk Union — Idempotent stock-deduction flag on orders
-- 0049_orders_stock_deducted.sql
--
-- Why:
--   Stock is moved out of products.stock when an order is placed/confirmed
--   and moved back when it is cancelled. That deduction now happens from
--   several entry points (Call Desk POST /orders, the standing-indent
--   draft confirms — dealer / admin / worker auto-confirm — and the
--   Razorpay pay-now completion). Without a marker, a restore on cancel
--   can't tell whether a given order ever had its stock deducted, and a
--   pay-now completion can't tell whether the cart path already deducted
--   at creation. Either ambiguity risks a double-deduct or a phantom
--   restore.
--
-- What:
--   orders.stock_deducted boolean NOT NULL DEFAULT false — a latch that
--   makes deduct/restore idempotent and paired:
--     • deduct  → set true  (only when currently false)
--     • restore → set false (only when currently true)
--
-- Backfill:
--   Every order that has reached a placed state (pending [deprecated] /
--   confirmed / dispatched / delivered) has already had its stock deducted
--   (the old create paths deducted unconditionally), so mark those true.
--   draft / payment_required / cancelled stay false (not yet committed, or
--   already reversed). Stock is re-seeded daily by the FGS stock entry, so
--   any deploy-boundary drift on a still-open same-day order self-heals.
--
-- Idempotent — safe to re-run.
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS stock_deducted boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN orders.stock_deducted IS
  'True once this order''s lines have been subtracted from products.stock. '
  'Cleared when the order is cancelled and stock is restored. Keeps '
  'deduction/restore idempotent across every confirm entry point.';

UPDATE orders
   SET stock_deducted = true
 WHERE stock_deducted = false
   AND status IN ('pending', 'confirmed', 'dispatched', 'delivered');
