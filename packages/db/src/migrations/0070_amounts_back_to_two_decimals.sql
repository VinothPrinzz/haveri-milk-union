-- ════════════════════════════════════════════════════════════════════
-- 0070 — RATES keep three decimals; AMOUNTS go back to two
--
-- Refines 0069, which moved every money column to 3dp. That created a
-- gap nobody wants: an order totalling 127.125 was RECORDED as 127.125
-- but CHARGED as 127.13, because Razorpay settles in integer paise and
-- cash cannot be paid in fractions of a paisa. The ledger and the bank
-- then disagreed by up to half a paisa per online payment.
--
-- The rule from here:
--
--   RATE  (what a thing costs per unit)  → numeric(p,3)   42.375
--   AMOUNT (what actually changes hands)  → numeric(p,2)   127.13
--
-- Staff still read and key the three-decimal rates they had in the old
-- package, and every figure that settles — line totals, GST, order
-- totals, invoices, ledger, wallet, payments, refunds — is exactly what
-- the dealer pays. Payment record and displayed amount can no longer
-- diverge, by construction.
--
-- This also removes the Play Store dependency: because totals stay 2dp,
-- an old (2dp) dealer app and the new API render identical amounts, so
-- the API can ship before the app update clears review.
--
-- LOSSLESS: verified at apply time that no row in any of these 47
-- columns carries a non-zero third decimal (nothing 3dp had been
-- entered yet), so narrowing rounds nothing. Do NOT replay this after
-- 3dp amounts exist — it would silently round real money.
--
-- Precision returns to its pre-0069 value in every case.
-- ════════════════════════════════════════════════════════════════════

-- ── Dealer orders ───────────────────────────────────────────────────
ALTER TABLE orders
  ALTER COLUMN subtotal    TYPE numeric(10, 2),
  ALTER COLUMN total_gst   TYPE numeric(10, 2),
  ALTER COLUMN grand_total TYPE numeric(10, 2);

-- unit_price stays numeric(11,3) — it is a rate.
ALTER TABLE order_items
  ALTER COLUMN gst_amount TYPE numeric(10, 2),
  ALTER COLUMN line_total TYPE numeric(10, 2);

-- ── Direct (cash/adhoc) sales ───────────────────────────────────────
ALTER TABLE direct_sales
  ALTER COLUMN subtotal    TYPE numeric(10, 2),
  ALTER COLUMN total_gst   TYPE numeric(10, 2),
  ALTER COLUMN grand_total TYPE numeric(10, 2);

ALTER TABLE direct_sale_items
  ALTER COLUMN gst_amount TYPE numeric(10, 2),
  ALTER COLUMN line_total TYPE numeric(10, 2);

-- ── Employee indents ────────────────────────────────────────────────
ALTER TABLE employee_orders
  ALTER COLUMN subtotal    TYPE numeric(14, 2),
  ALTER COLUMN total_gst   TYPE numeric(14, 2),
  ALTER COLUMN grand_total TYPE numeric(14, 2);

-- unit_price and mrp_reference stay numeric(15,3) — both are rates.
ALTER TABLE employee_order_items
  ALTER COLUMN gst_amount TYPE numeric(14, 2),
  ALTER COLUMN line_total TYPE numeric(14, 2);

ALTER TABLE employees
  ALTER COLUMN credit_limit    TYPE numeric(14, 2),
  ALTER COLUMN opening_balance TYPE numeric(14, 2);

ALTER TABLE employee_ledger
  ALTER COLUMN amount        TYPE numeric(14, 2),
  ALTER COLUMN balance_after TYPE numeric(14, 2);

-- ── Dealers, wallet & ledger ────────────────────────────────────────
ALTER TABLE dealers
  ALTER COLUMN credit_limit    TYPE numeric(10, 2),
  ALTER COLUMN opening_balance TYPE numeric(12, 2),
  ALTER COLUMN current_balance TYPE numeric(12, 2);

ALTER TABLE dealer_wallets
  ALTER COLUMN balance           TYPE numeric(12, 2),
  ALTER COLUMN last_topup_amount TYPE numeric(10, 2);

ALTER TABLE dealer_ledger
  ALTER COLUMN amount        TYPE numeric(12, 2),
  ALTER COLUMN balance_after TYPE numeric(12, 2);

-- ── Invoices & payments ─────────────────────────────────────────────
ALTER TABLE invoices
  ALTER COLUMN taxable_amount TYPE numeric(12, 2),
  ALTER COLUMN cgst           TYPE numeric(10, 2),
  ALTER COLUMN sgst           TYPE numeric(10, 2),
  ALTER COLUMN total_tax      TYPE numeric(10, 2),
  ALTER COLUMN total_amount   TYPE numeric(12, 2),
  ALTER COLUMN paid_amount    TYPE numeric(12, 2);

ALTER TABLE payments
  ALTER COLUMN amount TYPE numeric(12, 2);

ALTER TABLE cheques
  ALTER COLUMN amount       TYPE numeric(12, 2),
  ALTER COLUMN bank_charges TYPE numeric(10, 2);

-- ── Razorpay (must mirror integer paise exactly) ────────────────────
ALTER TABLE razorpay_payments
  ALTER COLUMN amount          TYPE numeric(10, 2),
  ALTER COLUMN amount_refunded TYPE numeric(10, 2);

ALTER TABLE razorpay_refunds
  ALTER COLUMN amount TYPE numeric(10, 2);

ALTER TABLE settlements
  ALTER COLUMN total_amount         TYPE numeric(14, 2),
  ALTER COLUMN gateway_fee          TYPE numeric(12, 2),
  ALTER COLUMN tax_on_fee           TYPE numeric(12, 2),
  ALTER COLUMN axis_credited_amount TYPE numeric(14, 2);

ALTER TABLE bank_reconciliation
  ALTER COLUMN bank_statement_amount TYPE numeric(14, 2),
  ALTER COLUMN system_amount         TYPE numeric(14, 2),
  ALTER COLUMN difference            TYPE numeric(14, 2);

-- ── Distribution & procurement ──────────────────────────────────────
ALTER TABLE route_sheets
  ALTER COLUMN total_amount TYPE numeric(12, 2);

-- unit_cost stays numeric(11,3) — a purchase rate. total_cost settles.
ALTER TABLE stock_receipts
  ALTER COLUMN total_cost TYPE numeric(12, 2);

-- ════════════════════════════════════════════════════════════════════
-- Deliberately UNCHANGED, still numeric(p,3) after this migration:
--
--   products.base_price / dealer_price / mrp / retail_dealer_price /
--     credit_inst_mrp_price / credit_inst_dealer_price /
--     parlour_dealer_price
--   price_revisions.old_price / new_price
--   price_chart.price
--   employee_subsidy_rules.subsidy_price
--   order_items.unit_price
--   direct_sale_items.unit_price
--   employee_order_items.unit_price / mrp_reference
--   stock_receipts.unit_cost
--   supplier_product_costs.unit_cost
--   routes.rate_per_trip
--   contractors.rate_per_km
-- ════════════════════════════════════════════════════════════════════
