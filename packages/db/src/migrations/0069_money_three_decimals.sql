-- ════════════════════════════════════════════════════════════════════
-- 0069 — Money carries THREE decimal places
--
-- The union ran a previous package that quoted and printed every rupee
-- figure to three decimals (Rate 42.500, not 42.50). Staff read and
-- cross-check those numbers by eye against old registers, so the second
-- decimal alone loses information they expect to see. Every money column
-- moves from numeric(p,2) to numeric(p+1,3).
--
-- Precision is bumped by one alongside the scale ON PURPOSE. Going
-- numeric(10,2) -> numeric(10,3) would silently shrink the integer side
-- from 99,999,999 to 9,999,999 and start throwing "numeric field
-- overflow" on the largest settlement rows. p+1 keeps the exact same
-- rupee range that exists today and only adds the new decimal.
--
-- NOT widened (these are not money):
--   gst_percent, subsidy_percent  — percentages, 2dp is already exact
--   pack_size                     — pack weight/volume
--   routes.total_km_per_day       — distance
--
-- orders is partitioned by month; ALTER on the parent cascades to all 24
-- partitions in the same statement, so they are not listed individually.
--
-- Existing values are preserved exactly: 42.50 becomes 42.500. Changing a
-- numeric's SCALE forces a full table rewrite under ACCESS EXCLUSIVE, so
-- run this while nobody is indenting (outside the 10:00-11:30 IST peak).
-- On this dataset the whole file is a few seconds.
--
-- The gateway boundary is deliberately NOT changed: Razorpay settles in
-- integer paise, so razorpay-client.ts still rounds rupees to 2dp when it
-- creates an order/refund/QR. A 3dp total is charged to the nearest paisa.
-- ════════════════════════════════════════════════════════════════════

-- ── Products & pricing masters ──────────────────────────────────────
ALTER TABLE products
  ALTER COLUMN base_price               TYPE numeric(11, 3),
  ALTER COLUMN dealer_price             TYPE numeric(11, 3),
  ALTER COLUMN mrp                      TYPE numeric(11, 3),
  ALTER COLUMN retail_dealer_price      TYPE numeric(11, 3),
  ALTER COLUMN credit_inst_mrp_price    TYPE numeric(11, 3),
  ALTER COLUMN credit_inst_dealer_price TYPE numeric(11, 3),
  ALTER COLUMN parlour_dealer_price     TYPE numeric(11, 3);

ALTER TABLE price_revisions
  ALTER COLUMN old_price TYPE numeric(11, 3),
  ALTER COLUMN new_price TYPE numeric(11, 3);

ALTER TABLE price_chart
  ALTER COLUMN price TYPE numeric(11, 3);

ALTER TABLE employee_subsidy_rules
  ALTER COLUMN subsidy_price TYPE numeric(13, 3);

-- ── Dealer orders ───────────────────────────────────────────────────
ALTER TABLE orders
  ALTER COLUMN subtotal    TYPE numeric(11, 3),
  ALTER COLUMN total_gst   TYPE numeric(11, 3),
  ALTER COLUMN grand_total TYPE numeric(11, 3);

ALTER TABLE order_items
  ALTER COLUMN unit_price TYPE numeric(11, 3),
  ALTER COLUMN gst_amount TYPE numeric(11, 3),
  ALTER COLUMN line_total TYPE numeric(11, 3);

-- ── Direct (cash/adhoc) sales ───────────────────────────────────────
ALTER TABLE direct_sales
  ALTER COLUMN subtotal    TYPE numeric(11, 3),
  ALTER COLUMN total_gst   TYPE numeric(11, 3),
  ALTER COLUMN grand_total TYPE numeric(11, 3);

ALTER TABLE direct_sale_items
  ALTER COLUMN unit_price TYPE numeric(11, 3),
  ALTER COLUMN gst_amount TYPE numeric(11, 3),
  ALTER COLUMN line_total TYPE numeric(11, 3);

-- ── Employee indents ────────────────────────────────────────────────
ALTER TABLE employee_orders
  ALTER COLUMN subtotal    TYPE numeric(15, 3),
  ALTER COLUMN total_gst   TYPE numeric(15, 3),
  ALTER COLUMN grand_total TYPE numeric(15, 3);

ALTER TABLE employee_order_items
  ALTER COLUMN unit_price    TYPE numeric(15, 3),
  ALTER COLUMN gst_amount    TYPE numeric(15, 3),
  ALTER COLUMN line_total    TYPE numeric(15, 3),
  ALTER COLUMN mrp_reference TYPE numeric(15, 3);

ALTER TABLE employees
  ALTER COLUMN credit_limit     TYPE numeric(15, 3),
  ALTER COLUMN opening_balance  TYPE numeric(15, 3);

ALTER TABLE employee_ledger
  ALTER COLUMN amount        TYPE numeric(15, 3),
  ALTER COLUMN balance_after TYPE numeric(15, 3);

-- ── Dealers, wallet & ledger ────────────────────────────────────────
ALTER TABLE dealers
  ALTER COLUMN credit_limit    TYPE numeric(11, 3),
  ALTER COLUMN opening_balance TYPE numeric(13, 3),
  ALTER COLUMN current_balance TYPE numeric(13, 3);

ALTER TABLE dealer_wallets
  ALTER COLUMN balance           TYPE numeric(13, 3),
  ALTER COLUMN last_topup_amount TYPE numeric(11, 3);

ALTER TABLE dealer_ledger
  ALTER COLUMN amount        TYPE numeric(13, 3),
  ALTER COLUMN balance_after TYPE numeric(13, 3);

-- ── Invoices & payments ─────────────────────────────────────────────
ALTER TABLE invoices
  ALTER COLUMN taxable_amount TYPE numeric(13, 3),
  ALTER COLUMN cgst           TYPE numeric(11, 3),
  ALTER COLUMN sgst           TYPE numeric(11, 3),
  ALTER COLUMN total_tax      TYPE numeric(11, 3),
  ALTER COLUMN total_amount   TYPE numeric(13, 3),
  ALTER COLUMN paid_amount    TYPE numeric(13, 3);

ALTER TABLE payments
  ALTER COLUMN amount TYPE numeric(13, 3);

ALTER TABLE cheques
  ALTER COLUMN amount       TYPE numeric(13, 3),
  ALTER COLUMN bank_charges TYPE numeric(11, 3);

-- ── Razorpay (stored rupee mirrors of paise amounts) ────────────────
ALTER TABLE razorpay_payments
  ALTER COLUMN amount          TYPE numeric(11, 3),
  ALTER COLUMN amount_refunded TYPE numeric(11, 3);

ALTER TABLE razorpay_refunds
  ALTER COLUMN amount TYPE numeric(11, 3);

ALTER TABLE settlements
  ALTER COLUMN total_amount         TYPE numeric(15, 3),
  ALTER COLUMN gateway_fee          TYPE numeric(13, 3),
  ALTER COLUMN tax_on_fee           TYPE numeric(13, 3),
  ALTER COLUMN axis_credited_amount TYPE numeric(15, 3);

ALTER TABLE bank_reconciliation
  ALTER COLUMN bank_statement_amount TYPE numeric(15, 3),
  ALTER COLUMN system_amount         TYPE numeric(15, 3),
  ALTER COLUMN difference            TYPE numeric(15, 3);

-- ── Distribution & procurement ──────────────────────────────────────
ALTER TABLE route_sheets
  ALTER COLUMN total_amount TYPE numeric(13, 3);

ALTER TABLE routes
  ALTER COLUMN rate_per_trip TYPE numeric(11, 3);

ALTER TABLE contractors
  ALTER COLUMN rate_per_km TYPE numeric(11, 3);

ALTER TABLE stock_receipts
  ALTER COLUMN unit_cost  TYPE numeric(11, 3),
  ALTER COLUMN total_cost TYPE numeric(13, 3);

ALTER TABLE supplier_product_costs
  ALTER COLUMN unit_cost TYPE numeric(11, 3);
