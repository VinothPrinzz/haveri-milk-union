-- ════════════════════════════════════════════════════════════════════
-- Haveri Milk Union — Product Image + Standing-Indent Flag
-- 0029_product_image_make_zero.sql
--
-- Why:
--   Two product columns the dealer-app redesign depends on, neither
--   of which exist in the DB yet:
--
--   1. `image_url` — the new Blinkit-style ProductCard renders an
--      image at the top of every tile. The admin web has had an
--      `imageUrl` field on the form for a while but it's never been
--      persisted because the column doesn't exist.
--
--   2. `make_zero_in_indents` — boolean controlling whether a
--      product is eligible to appear in a dealer's auto-generated
--      "standing indent" (the draft order created nightly by the
--      worker from each dealer's recurring template).
--
--      Semantics from the client:
--        FALSE → product IS included by default in standing indents
--                (the typical case — milk, curd, etc. that dealers
--                order every day without thinking)
--        TRUE  → product is NEVER auto-added (one-off items —
--                seasonal sweets, festival items, etc.)
--
--      The admin web form already submits this field as
--      `makeZeroInIndents`; this migration finally makes the column
--      it writes to exist.
--
-- What:
--   • ALTER products ADD COLUMN image_url text                — CDN/R2 URL
--   • ALTER products ADD COLUMN make_zero_in_indents boolean  — default FALSE
--   • Partial index on make_zero_in_indents = false so the
--     nightly standing-indent materializer's query stays fast even
--     as the product catalog grows.
--
-- Idempotent — safe to re-run.
-- ════════════════════════════════════════════════════════════════════

-- ── 1. Image URL ──
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS image_url text;

-- ── 2. Standing-indent eligibility flag ──
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS make_zero_in_indents boolean NOT NULL DEFAULT false;

-- ── 3. Partial index used by the standing-indent worker ──
-- The materializer's hot query is:
--   SELECT id, name, base_price, gst_percent
--   FROM products
--   WHERE deleted_at IS NULL
--     AND available = true
--     AND make_zero_in_indents = false
--   ORDER BY sort_order;
-- A partial index on rows where make_zero_in_indents = false
-- (the eligible set) keeps that query at O(log n) regardless of
-- how many one-off seasonal products get added over time.
CREATE INDEX IF NOT EXISTS idx_products_standing_eligible
  ON products (sort_order)
  WHERE deleted_at IS NULL
    AND available = true
    AND make_zero_in_indents = false;

-- ════════════════════════════════════════════════════════════════════
-- Done. After this:
--   • products.image_url is populatable (admin upload UI work tracked
--     separately — the column existing unblocks that work).
--   • products.make_zero_in_indents is the source of truth for what
--     can appear in a dealer's standing indent.
--   • Standing-indent materializer queries are index-backed.
-- ════════════════════════════════════════════════════════════════════
