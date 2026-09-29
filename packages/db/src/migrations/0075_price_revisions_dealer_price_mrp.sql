-- ═══════════════════════════════════════════════════════════════════
-- 0075_price_revisions_dealer_price_mrp.sql
--
-- price_revisions only ever recorded base_price (the NET Basic Price) and
-- GST. Staff do not revise the Basic Price: they set a Dealer Price (GST
-- inclusive, what the dealer app shows and what base_price is derived from)
-- and an MRP (what a Credit Inst-MRP customer pays on milk). The Price
-- Revisions page wrote the typed rate straight into base_price and left
-- dealer_price and mrp untouched, so the Price Chart and the dealer app kept
-- showing the old price while orders billed the new one, and the next save
-- on the Products page re-derived base_price from the stale dealer_price and
-- silently undid the revision. No revision was ever saved (0 rows), so there
-- is no history to repair.
--
-- The log now carries the two numbers staff actually change, plus where the
-- change came from: the Price Revisions page, or an edit on All Products
-- (which changed prices without leaving any record).
--
-- Additive only. Every new column is nullable or defaulted, no existing row
-- is read or rewritten. The API that writes these columns must not be
-- deployed before this has run: apply first, then deploy.
-- ═══════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE price_revisions
  ADD COLUMN IF NOT EXISTS old_dealer_price numeric(11, 3),
  ADD COLUMN IF NOT EXISTS new_dealer_price numeric(11, 3),
  ADD COLUMN IF NOT EXISTS old_mrp          numeric(11, 3),
  ADD COLUMN IF NOT EXISTS new_mrp          numeric(11, 3),
  ADD COLUMN IF NOT EXISTS source           text NOT NULL DEFAULT 'price_revision';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'price_revisions_source_check'
       AND conrelid = 'public.price_revisions'::regclass
  ) THEN
    ALTER TABLE price_revisions
      ADD CONSTRAINT price_revisions_source_check
      CHECK (source IN ('price_revision', 'product_edit'));
  END IF;
END $$;

COMMENT ON COLUMN price_revisions.old_price IS
  'products.base_price before the change: the NET Basic Price every dealer is billed (plus GST).';
COMMENT ON COLUMN price_revisions.new_price IS
  'products.base_price after the change, derived from new_dealer_price / (1 + GST).';
COMMENT ON COLUMN price_revisions.old_dealer_price IS
  'products.dealer_price before the change (GST inclusive). NULL on rows written before 0075.';
COMMENT ON COLUMN price_revisions.new_dealer_price IS
  'products.dealer_price after the change (GST inclusive).';
COMMENT ON COLUMN price_revisions.old_mrp IS
  'products.mrp before the change. NULL on rows written before 0075.';
COMMENT ON COLUMN price_revisions.new_mrp IS
  'products.mrp after the change.';
COMMENT ON COLUMN price_revisions.source IS
  'price_revision = Masters > Price Revisions; product_edit = an edit on All Products.';

COMMIT;
