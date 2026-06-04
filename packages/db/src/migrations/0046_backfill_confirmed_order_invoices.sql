-- ══════════════════════════════════════════════════════════════════
-- Haveri Milk Union — Backfill invoices for confirmed indent orders
-- 0046_backfill_confirmed_order_invoices.sql
--
-- WHY:
--   Standing-indent orders are materialised as drafts the night before
--   delivery and then auto-confirmed (or confirmed in-app) when the
--   route window closes. Neither path historically called invoice
--   generation, so confirmed orders existed with NO `invoices` row.
--   Result: they were missing from the admin "All Invoices" page and
--   from the dealer app's invoice/orders lists, even though they showed
--   up under "All Indents".
--
--   The going-forward fix enqueues a pdf-invoice job on confirm. This
--   migration heals the orders that were confirmed BEFORE that fix.
--
-- WHAT:
--   Inserts one `invoices` row per confirmed / dispatched / delivered
--   order that has no invoice yet. Totals are taken straight from the
--   order (subtotal = taxable, total_gst split evenly into CGST/SGST,
--   grand_total rounded = total_amount) — identical to what
--   invoice-pdf.ts computes.
--
--   The PDF itself is NOT rendered here. pdf_url is left NULL; the
--   dealer/admin "View Invoice" endpoint regenerates the PDF on demand
--   the first time it is opened (generateInvoicePdfSync). The list
--   pages only need the invoice ROW to display the line.
--
--   invoice_number mirrors the app format exactly:
--     INV-HMU-<delivery-year>-<first 8 hex of order id, uppercased>
--
-- Idempotent — ON CONFLICT (order_id) DO NOTHING, so re-running is safe
-- and never disturbs invoices already generated with a real PDF.
-- ══════════════════════════════════════════════════════════════════

INSERT INTO invoices (
    order_id,
    dealer_id,
    route_id,
    invoice_number,
    invoice_date,
    delivery_date,
    due_date,
    taxable_amount,
    cgst,
    sgst,
    total_tax,
    total_amount,
    payment_status,
    dealer_name,
    dealer_gst_number,
    dealer_address,
    pdf_url,
    pdf_generated_at
)
SELECT
    o.id,
    o.dealer_id,
    d.route_id,
    'INV-HMU-'
      || EXTRACT(YEAR FROM COALESCE(
            o.delivery_date,
            (o.created_at AT TIME ZONE 'Asia/Kolkata')::date))::int
      || '-'
      || upper(left(o.id::text, 8))                     AS invoice_number,
    COALESCE(o.confirmed_at, o.created_at)              AS invoice_date,
    COALESCE(
        o.delivery_date,
        (o.created_at AT TIME ZONE 'Asia/Kolkata')::date) AS delivery_date,
    (COALESCE(
        o.delivery_date,
        (o.created_at AT TIME ZONE 'Asia/Kolkata')::date)
        + INTERVAL '7 days')::date                     AS due_date,
    COALESCE(o.subtotal, 0)::numeric(12,2)             AS taxable_amount,
    (COALESCE(o.total_gst, 0) / 2)::numeric(10,2)      AS cgst,
    (COALESCE(o.total_gst, 0) / 2)::numeric(10,2)      AS sgst,
    COALESCE(o.total_gst, 0)::numeric(10,2)            AS total_tax,
    round(COALESCE(o.grand_total, 0))::numeric(12,2)   AS total_amount,
    'unpaid'                                            AS payment_status,
    d.name                                             AS dealer_name,
    d.gst_number                                       AS dealer_gst_number,
    NULLIF(
      concat_ws(', ', d.address, d.city, d.pin_code), '') AS dealer_address,
    NULL                                               AS pdf_url,
    NULL                                               AS pdf_generated_at
FROM orders o
JOIN dealers d ON d.id = o.dealer_id
WHERE o.status IN ('confirmed', 'dispatched', 'delivered')
  AND NOT EXISTS (
        SELECT 1 FROM invoices i WHERE i.order_id = o.id
  )
  -- Defensive: skip the (astronomically unlikely) case where the derived
  -- invoice_number already exists for a different order. invoice_number has
  -- its own UNIQUE constraint that ON CONFLICT (order_id) cannot catch, and
  -- a violation would abort the whole migration transaction.
  AND NOT EXISTS (
        SELECT 1 FROM invoices i2
        WHERE i2.invoice_number =
          'INV-HMU-'
          || EXTRACT(YEAR FROM COALESCE(
                o.delivery_date,
                (o.created_at AT TIME ZONE 'Asia/Kolkata')::date))::int
          || '-'
          || upper(left(o.id::text, 8))
  )
ON CONFLICT (order_id) DO NOTHING;
