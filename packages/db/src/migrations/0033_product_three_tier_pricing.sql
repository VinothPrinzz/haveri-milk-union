-- ══════════════════════════════════════════════════════════════════
-- Haveri Milk Union — Product Three-Tier Pricing
-- 0033_product_three_tier_pricing.sql
--
-- What this migration does:
--   Establishes three distinct product prices used by the admin panel:
--
--     base_price    → "Basic Price"   (pre-GST, auto-derived — unchanged)
--     dealer_price  → "Dealer-Price"  (gross price the client enters;
--                                      this is the value that USED to be
--                                      entered into the `mrp` column)
--     mrp           → "MRP"           (new client-entered field)
--
--   Margin = mrp - dealer_price is computed on read, never stored.
--
--   1. Ensures the `mrp` column exists (defensive — older deploys may
--      already have it; IF NOT EXISTS keeps any existing data).
--   2. Adds the new `dealer_price` column.
--   3. Backfills `dealer_price` from the value clients have historically
--      entered (the old `mrp`, falling back to `base_price`).
--   4. Backfills `mrp` (the real MRP) where missing — seeded equal to
--      dealer_price so existing rows start with a 0 margin until the
--      client enters a real MRP.
--
-- Run: psql $DATABASE_URL -f 0033_product_three_tier_pricing.sql
-- ══════════════════════════════════════════════════════════════════

BEGIN;

-- ── STEP 1 — Ensure both price columns exist ──────────────────────
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS mrp          numeric(10, 2);

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS dealer_price numeric(10, 2);

-- ── STEP 2 — Backfill Dealer-Price ────────────────────────────────
-- The price clients have been entering (old `mrp`) becomes Dealer-Price.
UPDATE products
SET dealer_price = COALESCE(dealer_price, mrp, base_price)
WHERE dealer_price IS NULL;

-- ── STEP 3 — Backfill MRP ─────────────────────────────────────────
-- Seed real MRP equal to Dealer-Price where missing (margin starts 0).
UPDATE products
SET mrp = COALESCE(mrp, dealer_price, base_price)
WHERE mrp IS NULL;

COMMIT;

-- ── Verification (run manually, not part of the transaction) ──────
-- SELECT code, name, base_price AS basic_price, dealer_price,
--        mrp, (mrp - dealer_price) AS margin
-- FROM products WHERE deleted_at IS NULL ORDER BY sort_order, name;
