-- ══════════════════════════════════════════════════════════════════
-- Haveri Milk Union — Product Marketing Fields Migration
-- 0006_product_marketing_fields.sql
--
-- Adds columns to the products table that the Marketing Module
-- admin panel expects but are missing from the original schema:
--
--   code            — short product code (e.g. "P01")
--   hsn_no          — HSN code for GST filing
--   pack_size       — numeric pack size (e.g. 500 for 500ml)
--   print_direction — "Across" or "Down" for indent sheets
--   packets_crate   — how many packets fit in one crate
--   report_alias    — short name used in report columns
--
-- Also adds last_login_at to users table (Fix #28).
--
-- Run with: psql $DATABASE_URL -f 0006_product_marketing_fields.sql
-- ══════════════════════════════════════════════════════════════════

-- ── Product fields ──
ALTER TABLE products ADD COLUMN IF NOT EXISTS code text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS hsn_no text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS pack_size numeric(8,2);
ALTER TABLE products ADD COLUMN IF NOT EXISTS print_direction text DEFAULT 'Across';
ALTER TABLE products ADD COLUMN IF NOT EXISTS packets_crate integer DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS report_alias text;

CREATE INDEX IF NOT EXISTS idx_products_code ON products (code) WHERE code IS NOT NULL;

-- Seed codes for existing products
DO $$
DECLARE
  rec RECORD;
  counter INT := 1;
BEGIN
  FOR rec IN
    SELECT id FROM products WHERE deleted_at IS NULL AND code IS NULL ORDER BY sort_order, name
  LOOP
    UPDATE products SET code = 'P' || LPAD(counter::text, 2, '0') WHERE id = rec.id;
    counter := counter + 1;
  END LOOP;
END $$;

-- Seed report_alias = name for existing products
UPDATE products SET report_alias = name WHERE report_alias IS NULL AND deleted_at IS NULL;

-- Seed pack_size from unit text (extract numeric part)
UPDATE products
SET pack_size = CASE
  WHEN unit ~ '^\d+' THEN CAST(SUBSTRING(unit FROM '^\d+') AS numeric)
  ELSE 0
END
WHERE pack_size IS NULL AND deleted_at IS NULL;

-- ── Users: last_login_at ──
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at timestamptz;

-- ══════════════════════════════════════════════════════════════════
-- Done. Added:
-- ✓ Product marketing fields (code, hsn_no, pack_size, etc.)
-- ✓ Auto-seeded product codes (P01, P02, ...)
-- ✓ Users last_login_at column
-- ══════════════════════════════════════════════════════════════════
