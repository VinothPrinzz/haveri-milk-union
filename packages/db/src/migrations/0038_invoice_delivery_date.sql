-- ════════════════════════════════════════════════════════════════════
-- Haveri Milk Union — Invoice Delivery Date
-- 0038_invoice_delivery_date.sql
--
-- Why:
--   An invoice now carries TWO dates, and both must be queryable /
--   displayable (admin invoice list + detail, dealer app, PDF):
--
--     • invoice_date   — the legal GST "date of issue". Already exists.
--                        Set once when the invoice is first generated.
--     • delivery_date  — the date the indent is FOR. Mirrors
--                        orders.delivery_date (added in migration 0031).
--
--   Storing delivery_date directly on `invoices` keeps it consistent
--   with the table's existing snapshot pattern (dealer_name,
--   dealer_gst_number, dealer_address are all snapshotted here) and
--   avoids a join to the partitioned `orders` table on every read.
--
-- What:
--   1. invoices.delivery_date date
--   2. Backfill from orders.delivery_date (fallback: invoice_date::date,
--      then created_at::date) for every existing invoice.
--   3. Index for date-range reporting on the delivery date.
--
-- Idempotent — safe to re-run.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Add the column ────────────────────────────────────────────────
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS delivery_date date;

COMMENT ON COLUMN invoices.delivery_date IS
  'Date the indent is for (snapshot of orders.delivery_date). '
  'Distinct from invoice_date, which is the legal GST date of issue.';


-- ── 2. Backfill existing invoices ────────────────────────────────────
-- Prefer the linked order''s delivery_date; fall back to the invoice''s
-- own dates for any invoice whose order row is missing or pre-0031.
UPDATE invoices i
SET delivery_date = COALESCE(
      o.delivery_date,
      (i.invoice_date AT TIME ZONE 'Asia/Kolkata')::date,
      (i.created_at   AT TIME ZONE 'Asia/Kolkata')::date
    )
FROM orders o
WHERE o.id = i.order_id
  AND i.delivery_date IS NULL;

-- Any invoice with no matching order row at all: use its own dates.
UPDATE invoices i
SET delivery_date = COALESCE(
      (i.invoice_date AT TIME ZONE 'Asia/Kolkata')::date,
      (i.created_at   AT TIME ZONE 'Asia/Kolkata')::date
    )
WHERE i.delivery_date IS NULL;


-- ── 3. Reporting index ───────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_invoices_delivery_date
  ON invoices (delivery_date DESC);

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- After this migration:
--   • generateInvoicePdfSync() writes invoice_date = now() (issue) and
--     delivery_date = order.delivery_date on insert.
--   • API invoice list / detail endpoints should add
--     i.delivery_date AS "deliveryDate" to their SELECTs.
--   • Admin InvoiceDetailPage.tsx + the dealer-app Invoice type should
--     surface both dates.
-- ════════════════════════════════════════════════════════════════════
