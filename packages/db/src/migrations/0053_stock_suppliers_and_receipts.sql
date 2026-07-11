-- ════════════════════════════════════════════════════════════════════
-- 0053 — Stock suppliers (master) + stock receipts (GRN lines)
--
-- The plant now records WHO each batch of received stock was purchased
-- from and at WHAT cost. Two pieces:
--
--   • suppliers       — reusable master of vendors stock is bought from,
--                       selected by name on the Stock Entry screen
--                       (mirrors the contractors master pattern).
--   • stock_receipts  — one row per purchase/receipt event: which product,
--                       which supplier, qty, unit cost, total cost, on a
--                       given business day. A product can be received from
--                       several suppliers on the same day → several rows.
--
-- fgs_stock_log.received stays the per-product-per-day total; it is now
-- derived as the SUM of that day's stock_receipts for the product (the
-- API rolls it up on save). Existing fgs_stock_log rows are untouched —
-- past days simply have no receipt detail, which is fine.
--
-- supplier_id and unit_cost are nullable so a plain "received from own
-- plant production" line (no purchase) still works.
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS suppliers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text,
  name        text NOT NULL,
  phone       text,
  address     text,
  gst_no      text,
  account_no  text,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);

CREATE INDEX IF NOT EXISTS idx_suppliers_active ON suppliers (active);
CREATE INDEX IF NOT EXISTS idx_suppliers_name   ON suppliers (name);

CREATE TABLE IF NOT EXISTS stock_receipts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id  uuid NOT NULL REFERENCES products (id) ON DELETE RESTRICT,
  -- ON DELETE SET NULL: deleting a supplier keeps the receipt history (the
  -- line just loses its supplier reference). Suppliers are soft-deleted
  -- anyway, so this is a belt-and-braces guard.
  supplier_id uuid REFERENCES suppliers (id) ON DELETE SET NULL,
  date        date NOT NULL,
  quantity    integer NOT NULL DEFAULT 0,
  unit_cost   numeric(10, 2),
  total_cost  numeric(12, 2),
  entered_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stock_receipts_product_date ON stock_receipts (product_id, date);
CREATE INDEX IF NOT EXISTS idx_stock_receipts_supplier     ON stock_receipts (supplier_id);
CREATE INDEX IF NOT EXISTS idx_stock_receipts_date         ON stock_receipts (date);
