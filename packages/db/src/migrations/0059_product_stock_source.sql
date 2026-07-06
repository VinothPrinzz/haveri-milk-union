-- ════════════════════════════════════════════════════════════════════
-- Haveri Milk Union — variant SKUs draw stock from a base SKU
-- 0059_product_stock_source.sql
--
-- Why:
--   "HTM 1000ML (Subsidy)" (code PD0191S, migration 0056) is a half-price
--   pricing/scheme variant of "HTM 1000ML" (PD0191) — the SAME physical
--   pouch, a distinct SKU only so it gets its own route-sheet column. But it
--   carries its OWN products.stock, which stays 0 because FGS only ever
--   enters stock against the base SKU PD0191. So confirming a subsidy indent
--   fails the stock gate ("Not enough stock for: HTM 1000ML (Subsidy)
--   (need 6, have 0)") even though the physical milk is on hand.
--
-- What:
--   • Add products.stock_source_product_id — a self-reference. When set, all
--     stock reads / deductions / restores for that SKU target the referenced
--     product's stock instead of its own. NULL = the SKU uses its own stock
--     (the default for every existing product).
--   • Point PD0191S at PD0191 so the subsidy line draws from HTM 1000ML.
--   • Copy PD0191's HSN onto PD0191S so invoices/reports match the base good.
--
-- The application resolves the target with COALESCE(stock_source_product_id,
-- id) in stock-check.ts (dealer/admin confirm, razorpay pay-now, cancel
-- restore) and in the worker's auto-confirm job — see those files.
--
-- Idempotent — ADD COLUMN IF NOT EXISTS + a keyed UPDATE make re-runs a no-op.
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS stock_source_product_id uuid REFERENCES products(id);

-- Subsidy SKU → base physical SKU, and inherit the base HSN.
UPDATE products s
   SET stock_source_product_id = b.id,
       hsn_no                  = b.hsn_no,
       updated_at              = now()
  FROM products b
 WHERE s.code = 'PD0191S'
   AND b.code = 'PD0191'
   AND b.deleted_at IS NULL
   AND s.stock_source_product_id IS DISTINCT FROM b.id;
