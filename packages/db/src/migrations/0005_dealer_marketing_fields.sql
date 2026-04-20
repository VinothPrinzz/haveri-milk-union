-- ══════════════════════════════════════════════════════════════════
-- Haveri Milk Union — Dealer Marketing Fields Migration
-- 0005_dealer_marketing_fields.sql
--
-- Adds fields to the dealers table that the Marketing Module ERP
-- frontend requires but are missing from the original schema:
--
--   code          — e.g. "A1", "B3" (letter + number, assigned by admin)
--   customer_type — "Retail-Dealer" | "Credit Inst-MRP" | "Credit Inst-Dealer" | "Parlour-Dealer"
--   rate_category — matches price chart rate category name
--   pay_mode      — "Cash" | "Credit"
--   route_id      — which delivery route this dealer is on
--   bank          — bank name for credit dealers
--   officer_name  — assigned sales officer name
--
-- Also seeds codes for existing dealers if they don't have one.
--
-- Run with: psql $DATABASE_URL -f 0005_dealer_marketing_fields.sql
-- ══════════════════════════════════════════════════════════════════


-- ┌─────────────────────────────────────────┐
-- │       NEW ENUM TYPES                     │
-- └─────────────────────────────────────────┘

DO $$ BEGIN
  CREATE TYPE customer_type AS ENUM (
    'Retail-Dealer',
    'Credit Inst-MRP',
    'Credit Inst-Dealer',
    'Parlour-Dealer'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE pay_mode AS ENUM ('Cash', 'Credit');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ┌─────────────────────────────────────────┐
-- │       ALTER TABLE dealers                │
-- └─────────────────────────────────────────┘

-- Dealer code — short alphanumeric code (e.g. "A1", "B3")
-- Used by Call Desk staff when recording indents
ALTER TABLE dealers
  ADD COLUMN IF NOT EXISTS code text UNIQUE;

-- Customer type — determines which price chart rate applies
ALTER TABLE dealers
  ADD COLUMN IF NOT EXISTS customer_type customer_type NOT NULL DEFAULT 'Retail-Dealer';

-- Rate category — must match a row in rate_categories table name column
ALTER TABLE dealers
  ADD COLUMN IF NOT EXISTS rate_category text NOT NULL DEFAULT 'Retail-Dealer';

-- Pay mode — Cash dealers pay on delivery; Credit dealers are billed monthly
ALTER TABLE dealers
  ADD COLUMN IF NOT EXISTS pay_mode pay_mode NOT NULL DEFAULT 'Cash';

-- Route assignment — which route delivers to this dealer
-- Nullable FK to routes table (dealer may not be assigned yet)
ALTER TABLE dealers
  ADD COLUMN IF NOT EXISTS route_id uuid REFERENCES routes(id) ON DELETE SET NULL;

-- Bank name — required for Credit dealers (for reconciliation)
ALTER TABLE dealers
  ADD COLUMN IF NOT EXISTS bank text;

-- Assigned officer name — sales officer managing this dealer account
ALTER TABLE dealers
  ADD COLUMN IF NOT EXISTS officer_name text;


-- ┌─────────────────────────────────────────┐
-- │       INDEXES                            │
-- └─────────────────────────────────────────┘

CREATE INDEX IF NOT EXISTS idx_dealers_code ON dealers (code) WHERE code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_dealers_route ON dealers (route_id) WHERE route_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_dealers_customer_type ON dealers (customer_type);
CREATE INDEX IF NOT EXISTS idx_dealers_pay_mode ON dealers (pay_mode);


-- ┌─────────────────────────────────────────┐
-- │  SEED CODES FOR EXISTING DEALERS         │
-- └─────────────────────────────────────────┘
-- Assigns sequential letter-based codes (A1, A2, ...) to existing
-- dealers that don't have a code yet. Uses alphabetical order by name
-- so codes are deterministic.

DO $$
DECLARE
  rec RECORD;
  counter INT := 1;
  current_letter CHAR := 'A';
  dealer_letter CHAR;
BEGIN
  FOR rec IN
    SELECT id, name FROM dealers
    WHERE deleted_at IS NULL AND code IS NULL
    ORDER BY name ASC
  LOOP
    -- Derive letter from first character of dealer name (uppercased)
    dealer_letter := UPPER(SUBSTR(rec.name, 1, 1));

    -- Check if this letter has existing codes
    SELECT COALESCE(MAX(CAST(SUBSTR(code, 2) AS INT)), 0) + 1
    INTO counter
    FROM dealers
    WHERE code LIKE dealer_letter || '%'
      AND code ~ ('^' || dealer_letter || '[0-9]+$')
      AND deleted_at IS NULL;

    UPDATE dealers
    SET code = dealer_letter || counter
    WHERE id = rec.id;
  END LOOP;
END $$;
