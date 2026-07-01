-- ════════════════════════════════════════════════════════════════════
-- Haveri Milk Union — HTM 1000ML Subsidy product
-- 0056_htm1000ml_subsidy_product.sql
--
-- Why:
--   Sales staff need to record customer indents for subsidised HTM 1000ML
--   (customer pays 50%, the union subsidises the other 50%). On the route
--   sheet this must show as its OWN "across" column — separate from the
--   full-price HTM 1000ML — labelled "HTM 1000ML (sub)".
--
-- How:
--   The route-sheet report (GET /api/v1/reports/route-sheet) builds its
--   across columns straight from products where print_direction = 'Across',
--   using report_alias as the column header. So the cleanest way to get a
--   dedicated column is a dedicated product row. This is a distinct SKU of
--   the same physical pouch — a pricing/scheme variant, not a new good.
--
-- What:
--   Insert one product "HTM 1000ML (Subsidy)" that copies the base HTM
--   1000ML row (code PD0191) — same category, unit, pack size, GST,
--   packets/crate, sort order — but at HALF the price and with:
--     • code         = 'PD0191S'          (stable key the API resolves by)
--     • report_alias = 'HTM 1000ML (sub)' (the route-sheet column header)
--     • make_zero_in_indents = true       (hidden from the standing-indent
--                                           pickers; placed only via the new
--                                           Subsidy Indents page)
--
--   Prices are derived from whatever PD0191 currently holds, so this stays
--   correct even after rate-chart revisions (e.g. migration 0027).
--
-- Idempotent — the NOT EXISTS guard makes re-runs a no-op.
-- ════════════════════════════════════════════════════════════════════

INSERT INTO products (
  name, code, report_alias, category_id, icon, unit, pack_size,
  base_price, gst_percent, print_direction, packets_crate, sort_order,
  retail_dealer_price, credit_inst_mrp_price, credit_inst_dealer_price, parlour_dealer_price,
  available, make_zero_in_indents
)
SELECT
  'HTM 1000ML (Subsidy)',
  'PD0191S',
  'HTM 1000ML (sub)',
  p.category_id,
  p.icon,
  p.unit,
  p.pack_size,
  ROUND(p.base_price * 0.5, 2),
  p.gst_percent,
  'Across',
  p.packets_crate,
  p.sort_order,
  ROUND(COALESCE(p.retail_dealer_price,     p.base_price) * 0.5, 2),
  ROUND(COALESCE(p.credit_inst_mrp_price,   p.base_price) * 0.5, 2),
  ROUND(COALESCE(p.credit_inst_dealer_price,p.base_price) * 0.5, 2),
  ROUND(COALESCE(p.parlour_dealer_price,    p.base_price) * 0.5, 2),
  true,
  true
FROM products p
WHERE p.code = 'PD0191'          -- HTM 1000ML
  AND p.deleted_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM products x WHERE x.code = 'PD0191S');
