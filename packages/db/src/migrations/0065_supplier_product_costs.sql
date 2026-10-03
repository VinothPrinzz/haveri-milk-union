-- ════════════════════════════════════════════════════════════════════
-- 0065 — Supplier product-wise cost (purchase rate card)
--
-- Until now the unit cost of received stock was typed fresh on every GRN
-- line in Stock Entry. The same supplier charges the same rate for the
-- same product day after day, so the operator re-keyed it (and got it
-- wrong) every morning.
--
-- supplier_product_costs is the master: ONE current purchase rate per
-- (supplier, product). Stock Entry reads it to pre-fill the unit cost the
-- moment a supplier is picked on a receipt line; the operator can still
-- override the filled value for that one receipt.
--
-- This table is a DEFAULT, not history. stock_receipts already snapshots
-- the unit_cost/total_cost that was actually used, so revising a rate here
-- never rewrites past purchases.
--
-- ON DELETE CASCADE on both FKs: a rate card line is meaningless without
-- its supplier or product, and neither carries financial history itself
-- (suppliers are soft-deleted anyway, so the cascade is a belt-and-braces
-- guard for hard deletes).
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS supplier_product_costs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id uuid NOT NULL REFERENCES suppliers (id) ON DELETE CASCADE,
  product_id  uuid NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  unit_cost   numeric(10, 2) NOT NULL,
  updated_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- One current rate per supplier+product — the ON CONFLICT target the bulk
  -- save upserts against. Declared inline (not as a separate unique index) so
  -- the shape matches the drizzle schema's unique() exactly.
  CONSTRAINT uq_supplier_product_cost UNIQUE (supplier_id, product_id)
);

-- Stock Entry looks rates up product-first (one dialog = one product).
CREATE INDEX IF NOT EXISTS idx_supplier_product_costs_product
  ON supplier_product_costs (product_id);
