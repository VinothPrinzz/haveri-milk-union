-- ════════════════════════════════════════════════════════════════════
-- Haveri Milk Union — Reports Performance Indexes
-- 0012_reports_indexes.sql
--
-- Supports the 11 report endpoints (2 Reports + 9 Sales Reports) when
-- running against 100+ dealers with 20k+ orders/month.
--
-- Every index is partial where possible (WHERE deleted_at IS NULL,
-- WHERE status != 'cancelled') to keep the index small and hot.
--
-- Idempotent — safe to re-run.
-- ════════════════════════════════════════════════════════════════════

-- ── 1. Primary date-range filter on orders ────────────────────────
-- Used by every sales report that filters created_at::date IN [from, to]
-- AND status != 'cancelled'. Partial index drops ~0% of rows initially
-- but becomes valuable as cancellations accumulate over time.
CREATE INDEX IF NOT EXISTS idx_orders_date_noncancelled
  ON orders ((created_at::date))
  WHERE status != 'cancelled';


-- ── 2. Officer-wise sales filter ──────────────────────────────────
-- Officer Wise report joins orders ON officer_id IS NOT NULL.
-- Partial index keeps it fast because only Call Desk / Officer orders
-- have officer_id set (dealer self-placed orders have NULL).
CREATE INDEX IF NOT EXISTS idx_orders_officer_date
  ON orders (officer_id, (created_at::date))
  WHERE officer_id IS NOT NULL AND status != 'cancelled';


-- ── 3. Route Sheet single-day lookup ──────────────────────────────
-- Route Sheet filters orders for a single date within a zone.
CREATE INDEX IF NOT EXISTS idx_orders_zone_date
  ON orders (zone_id, (created_at::date))
  WHERE status != 'cancelled';


-- ── 4. Payment-mode date filter (cash sales, credit sales) ────────
CREATE INDEX IF NOT EXISTS idx_orders_paymode_date
  ON orders (payment_mode, (created_at::date))
  WHERE status != 'cancelled';


-- ── 5. Direct sales date + officer ────────────────────────────────
-- Covers Gate Pass Report, Officer Wise, Adhoc Sales, Sales Register.
CREATE INDEX IF NOT EXISTS idx_direct_sales_date_officer
  ON direct_sales (sale_date, officer_id);

-- Customer type + date (Gate Pass Report filters agent type only)
CREATE INDEX IF NOT EXISTS idx_direct_sales_type_date
  ON direct_sales (customer_type, sale_date);


-- ── 6. GST Statement aggregation helper ───────────────────────────
-- Groups order_items by (product_id, gst_percent). Composite helps
-- the planner when combined with order_id filter from parent orders.
CREATE INDEX IF NOT EXISTS idx_order_items_product_gst
  ON order_items (product_id, gst_percent);

-- Direct sale items mirror — GST Statement includes them
CREATE INDEX IF NOT EXISTS idx_direct_sale_items_product_gst
  ON direct_sale_items (product_id, gst_percent);


-- ── 7. Products master — filter by category for Daily Sales Statement ─
CREATE INDEX IF NOT EXISTS idx_products_category_sort
  ON products (category_id, sort_order)
  WHERE deleted_at IS NULL;

-- Products by code — fixed Taluka-summary lookup resolves codes to ids
CREATE INDEX IF NOT EXISTS idx_products_code_lookup
  ON products (code)
  WHERE deleted_at IS NULL AND code IS NOT NULL;


-- ── 8. Routes master — ordered listing ─────────────────────────────
-- Most reports iterate routes by code for stable column ordering.
CREATE INDEX IF NOT EXISTS idx_routes_active_code
  ON routes (code)
  WHERE deleted_at IS NULL AND active = true;


-- ── 9. Invoices date scan (GST Statement grand totals) ────────────
-- Already have idx_invoices_date from 0001 — documented here for traceability.
-- No-op if it exists.


-- ── 10. System settings for report configuration ──────────────────
-- Small helper to store admin-tunable category groupings, cash modes,
-- and the 4 fixed cookie-product codes used by Taluka/Agent summary.
-- If your system_settings table already exists with (category, key, value),
-- this just seeds defaults.
INSERT INTO system_settings (category, key, value) VALUES
  ('reports', 'category_groups',       '{"milk":["Milk"],"curd":["Curd"],"lassi":["Lassi","Buttermilk"]}'),
  ('reports', 'cash_payment_modes',    '["cash","upi","wallet"]'),
  ('reports', 'milk_category_group',   '["Milk","Curd","Lassi","Buttermilk"]'),
  ('reports', 'taluka_fixed_products', '[{"code":"COO20","label":"Cookies 20gm"},{"code":"BCK100","label":"Butter Cookies 100gm"},{"code":"KOD180","label":"Kodubale 180gm"},{"code":"PAN400","label":"Paneer Nippattu 400gm"}]'),
  ('reports', 'crate_packets_default', '20')
ON CONFLICT (category, key) DO NOTHING;


-- ════════════════════════════════════════════════════════════════════
-- Done. New indexes:
--   ✓ idx_orders_date_noncancelled      — all date-range reports
--   ✓ idx_orders_officer_date            — officer-wise
--   ✓ idx_orders_zone_date               — route sheet
--   ✓ idx_orders_paymode_date            — cash / credit
--   ✓ idx_direct_sales_date_officer      — direct-sale reports
--   ✓ idx_direct_sales_type_date         — gate pass
--   ✓ idx_order_items_product_gst        — GST statement
--   ✓ idx_direct_sale_items_product_gst  — GST statement
--   ✓ idx_products_category_sort         — daily statement grouping
--   ✓ idx_products_code_lookup           — fixed-code resolution
--   ✓ idx_routes_active_code             — route-ordered reports
--
-- Also seeded 5 system_settings rows under category='reports' for
-- tunable category mappings, cash mode set, and fixed cookie codes.
-- ════════════════════════════════════════════════════════════════════
