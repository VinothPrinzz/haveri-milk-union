-- ════════════════════════════════════════════════════════════════════
-- Haveri Milk Union — Dealer Standing Indents
-- 0030_dealer_standing_indents.sql
--
-- Why:
--   The dealer-app redesign introduces a "standing indent" concept —
--   each dealer maintains a per-product template of default daily
--   quantities. A nightly worker (~04:00 IST) materializes that
--   template into a draft order for each upcoming delivery date,
--   which the dealer then edits/confirms via the Indent tab.
--
--   The template lives in `dealer_standing_indents`; the
--   materialized drafts live in `orders` (existing table, now with
--   the `delivery_date` column added by migration 0031).
--
--   Pause windows (`dealer_indent_pauses`) handle the "shop closed
--   for a week" case — the worker checks these before materializing.
--
-- What:
--   1. dealer_standing_indents  — (dealer, product, default_qty, active)
--   2. dealer_indent_pauses     — (dealer, from_date, to_date, reason)
--
-- Edit discipline:
--   `dealer_standing_indents` is the TEMPLATE. It is edited only via
--   explicit user action ("Manage standing indent" screen, or the
--   inline "Make this the new daily default" affordance). Day-to-day
--   +/- on the Indent tab edits the materialized `orders` row, not
--   this table — that separation keeps today's edits from leaking
--   into tomorrow's order.
-- ════════════════════════════════════════════════════════════════════


-- ┌─────────────────────────────────────────┐
-- │   1. dealer_standing_indents              │
-- └─────────────────────────────────────────┘

CREATE TABLE IF NOT EXISTS dealer_standing_indents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dealer_id    uuid NOT NULL
               REFERENCES dealers(id) ON DELETE CASCADE,
  product_id   uuid NOT NULL
               REFERENCES products(id) ON DELETE RESTRICT,
  default_qty  integer NOT NULL DEFAULT 0
               CHECK (default_qty >= 0),
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- One row per dealer × product. Quantity changes are UPDATEs, not new
-- rows. Toggling a product out of the standing indent is `active=false`
-- rather than DELETE (preserves the dealer's previous default_qty so
-- they can re-enable without re-entering it).
CREATE UNIQUE INDEX IF NOT EXISTS uq_dealer_standing_indents_dealer_product
  ON dealer_standing_indents (dealer_id, product_id);

-- The materializer's per-dealer fetch:
--   SELECT product_id, default_qty
--   FROM dealer_standing_indents
--   WHERE dealer_id = $1 AND active = true AND default_qty > 0;
CREATE INDEX IF NOT EXISTS idx_dealer_standing_indents_active
  ON dealer_standing_indents (dealer_id)
  WHERE active = true AND default_qty > 0;


-- ┌─────────────────────────────────────────┐
-- │   2. dealer_indent_pauses                 │
-- └─────────────────────────────────────────┘
-- A dealer can declare a closed-shop window (vacation, festival closure,
-- equipment failure, etc). The materializer skips any delivery_date
-- that falls inside an active pause for that dealer.

CREATE TABLE IF NOT EXISTS dealer_indent_pauses (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dealer_id   uuid NOT NULL
              REFERENCES dealers(id) ON DELETE CASCADE,
  from_date   date NOT NULL,
  to_date     date NOT NULL,
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (to_date >= from_date)
);

-- Index for the materializer's "is dealer paused on date X" check:
--   SELECT 1 FROM dealer_indent_pauses
--   WHERE dealer_id = $1 AND $2::date BETWEEN from_date AND to_date
--   LIMIT 1;
CREATE INDEX IF NOT EXISTS idx_dealer_indent_pauses_dealer_range
  ON dealer_indent_pauses (dealer_id, from_date, to_date);

-- We deliberately do NOT enforce non-overlapping pauses with an EXCLUDE
-- constraint. Overlaps are harmless (the existence check is a LIMIT 1)
-- and admin/support staff occasionally need to layer a one-day pause
-- inside a longer one without first deleting the longer one.


-- ════════════════════════════════════════════════════════════════════
-- Done. After this:
--   • dealer_standing_indents holds each dealer's per-product template.
--   • dealer_indent_pauses holds vacation/closed-shop windows.
--   • Both tables are append-mostly with targeted UPDATEs (no DELETE
--     on standing_indents — toggle active instead).
-- ════════════════════════════════════════════════════════════════════
