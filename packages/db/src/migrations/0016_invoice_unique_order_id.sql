-- ══════════════════════════════════════════════════════════════════
-- Haveri Milk Union — Enforce one-invoice-per-order
-- 0016_invoice_unique_order_id.sql
--
-- Adds a UNIQUE index on invoices.order_id so:
--   (a) ON CONFLICT (order_id) DO UPDATE works in invoice-pdf.ts
--   (b) Db-level guarantee: an order has at most one invoice
--
-- Idempotent — safe to re-run.
-- ══════════════════════════════════════════════════════════════════

-- Defensive de-dup in case any duplicate invoices exist.
-- Keeps the most recent invoice (highest created_at) per order.
DELETE FROM invoices a
USING invoices b
WHERE a.order_id = b.order_id
  AND a.created_at < b.created_at;

-- Drop the old non-unique index if it exists, replace with a unique one.
DROP INDEX IF EXISTS idx_invoices_order;

CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_order_id
  ON invoices (order_id);
