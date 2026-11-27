-- ════════════════════════════════════════════════════════════════════
-- Haveri Milk Union — Contractor entries by route officers
-- 0083_dtc_officer_entries.sql
--
-- Why:
--   A route officer hears of a transport contractor's short delivery, crate
--   or product shortage, short km, extra km / trip or a penalty case on
--   their routes. They record it in their own login, against the route and
--   its contractor, and it is carried onto that route's monthly DTC bill as
--   an automatic line (source_ref = the entry), so the union recovers it
--   (or pays it, for extra km / trips) when the bill is paid.
--
-- What:
--   • dtc_officer_entries   — one row per entry. Amounts are worked out by
--                             the API (dealer price, crate rate, route
--                             terms), never taken from the browser.
--   • dtc_bill_lines.head   — + 'short_supply', so a customer's short
--                             delivery and a product shortage found at a
--                             check are separate lines on the bill.
--
-- Idempotent — IF NOT EXISTS, and the head CHECK is dropped and re-added.
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS dtc_officer_entries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_date       date NOT NULL,
  route_id         uuid NOT NULL REFERENCES routes(id) ON DELETE RESTRICT,
  -- The route's contractor when the entry was saved
  contractor_id    uuid REFERENCES contractors(id) ON DELETE SET NULL,
  shift            text NOT NULL DEFAULT 'morning' CHECK (shift IN ('morning', 'evening')),
  type             text NOT NULL CHECK (type IN (
                     'short_supply', 'crate_shortage', 'product_shortage',
                     'km_short', 'extra_km', 'extra_trip', 'penalty')),
  -- Short supply only: the customer who was delivered short
  dealer_id        uuid REFERENCES dealers(id) ON DELETE SET NULL,
  -- How it came to light
  report_source    text CHECK (report_source IN (
                     'customer_call', 'officer_visit', 'dispatch_check', 'return_check', 'on_route')),
  -- Short supply / product shortage: [{ productId, name, qty, rate, amount }]
  items            jsonb NOT NULL DEFAULT '[]'::jsonb,
  crates_sent      int CHECK (crates_sent IS NULL OR crates_sent >= 0),
  crates_returned  int CHECK (crates_returned IS NULL OR crates_returned >= 0),
  -- km short / extra km: km; crate shortage: crates short; extra trip:
  -- trips on a trip-basis route, else the trip's km. unit says which.
  qty              numeric(12, 3),
  unit             text CHECK (unit IN ('km', 'trip', 'crate', 'packet')),
  rate             numeric(10, 3),
  km_expected      numeric(8, 2),
  km_run           numeric(8, 2),
  amount           numeric(12, 2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  -- Penalty: late / not clean / misbehaviour / other; km short, extra km: why
  reason           text,
  -- Penalty: order or notice number
  reference        text,
  remarks          text,
  photo_url        text,
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  deleted_by       uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_dtc_officer_entries_route_date
  ON dtc_officer_entries (route_id, entry_date) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_dtc_officer_entries_date
  ON dtc_officer_entries (entry_date) WHERE deleted_at IS NULL;


-- ── New bill line head: short_supply ────────────────────────────────
ALTER TABLE dtc_bill_lines DROP CONSTRAINT IF EXISTS dtc_bill_lines_head_check;
ALTER TABLE dtc_bill_lines ADD CONSTRAINT dtc_bill_lines_head_check CHECK (head IN (
  -- earnings
  'extra_km', 'extra_trip', 'extra_litre', 'other_earning',
  -- deductions
  'crate', 'packet', 'short_supply', 'km', 'dues', 'security_deposit', 'gps',
  'penalty', 'advance', 'carry_forward', 'tds', 'other_deduction'));
