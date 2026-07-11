-- ════════════════════════════════════════════════════════════════════
-- Haveri Milk Union — Marketing Module v1.4 Schema
-- 0013_marketing_module_v1.sql
--
-- Adds:
--   • Dealer address fields: account_no, address_type, state, area,
--     house_no, street, last_indent_at (+ trigger)
--   • Contractor business fields: bank_name, account_no, address_type,
--     state, city, area, house_no, street, email, period_from,
--     period_to, rate_per_km
--   • Batch dispatch_time (time-of-day, seeded from routes.dispatch_time)
--   • Route primary_batch_id (seeded from batch_routes junction)
--   • System settings for state / city / address_type / taluka lists
--
-- Retains: routes.dispatch_time (NOT dropped — kept as fallback for
--          two releases so existing Route Sheet queries stay valid).
--
-- Idempotent — safe to re-run.
-- ════════════════════════════════════════════════════════════════════


-- ══════════════════════════════════════════════════════════════════
-- 1. DEALERS — new address + last-indent columns
-- ══════════════════════════════════════════════════════════════════
ALTER TABLE dealers ADD COLUMN IF NOT EXISTS account_no      text;
ALTER TABLE dealers ADD COLUMN IF NOT EXISTS address_type    text;
ALTER TABLE dealers ADD COLUMN IF NOT EXISTS state           text DEFAULT 'Karnataka';
ALTER TABLE dealers ADD COLUMN IF NOT EXISTS area            text;
ALTER TABLE dealers ADD COLUMN IF NOT EXISTS house_no        text;
ALTER TABLE dealers ADD COLUMN IF NOT EXISTS street          text;
ALTER TABLE dealers ADD COLUMN IF NOT EXISTS last_indent_at  timestamptz;

-- Constrain address_type to a short enum without needing a new type
DO $$ BEGIN
  ALTER TABLE dealers
    ADD CONSTRAINT chk_dealers_address_type
    CHECK (address_type IS NULL OR address_type IN ('Office','Residence'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Backfill last_indent_at from existing orders (non-cancelled)
UPDATE dealers d
SET last_indent_at = sub.last_at
FROM (
  SELECT dealer_id, MAX(created_at) AS last_at
  FROM orders
  WHERE status != 'cancelled'
  GROUP BY dealer_id
) sub
WHERE sub.dealer_id = d.id
  AND d.last_indent_at IS NULL;

-- Trigger function: bump last_indent_at on each new non-cancelled order
-- (Only insert is tracked. If an order is later cancelled we don't
--  rewind — acceptable trade-off per the spec review.)
CREATE OR REPLACE FUNCTION update_dealer_last_indent()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM 'cancelled' THEN
    UPDATE dealers
      SET last_indent_at = NEW.created_at
    WHERE id = NEW.dealer_id
      AND (last_indent_at IS NULL OR last_indent_at < NEW.created_at);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_update_dealer_last_indent ON orders;

-- Note: orders is partitioned (monthly). PG 11+ propagates triggers on
-- the parent to all partitions automatically. If you are on PG 10 or
-- older, this trigger needs creating on each partition individually.
CREATE TRIGGER trg_update_dealer_last_indent
  AFTER INSERT ON orders
  FOR EACH ROW
  EXECUTE FUNCTION update_dealer_last_indent();

CREATE INDEX IF NOT EXISTS idx_dealers_last_indent
  ON dealers (last_indent_at DESC)
  WHERE deleted_at IS NULL;


-- ══════════════════════════════════════════════════════════════════
-- 2. CONTRACTORS — banking + address + period + rate
-- ══════════════════════════════════════════════════════════════════
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS bank_name     text;
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS account_no    text;
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS address_type  text;
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS state         text DEFAULT 'Karnataka';
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS city          text;
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS area          text;
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS house_no      text;
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS street        text;
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS email         text;
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS period_from   date;
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS period_to     date;
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS rate_per_km   numeric(10, 2);

DO $$ BEGIN
  ALTER TABLE contractors
    ADD CONSTRAINT chk_contractors_address_type
    CHECK (address_type IS NULL OR address_type IN ('Office','Residence'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE contractors
    ADD CONSTRAINT chk_contractors_period_order
    CHECK (period_from IS NULL OR period_to IS NULL OR period_from <= period_to);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_contractors_period
  ON contractors (period_from, period_to)
  WHERE deleted_at IS NULL AND period_to IS NOT NULL;


-- ══════════════════════════════════════════════════════════════════
-- 3. BATCHES — dispatch_time (machine-readable time-of-day)
-- ══════════════════════════════════════════════════════════════════
ALTER TABLE batches ADD COLUMN IF NOT EXISTS dispatch_time time;

-- Seed batches.dispatch_time from the median dispatch_time of the
-- routes currently linked via batch_routes. Parses "5:30 AM" style
-- strings. Any that fail to parse stay NULL.
UPDATE batches b
SET dispatch_time = sub.dt
FROM (
  SELECT br.batch_id,
    -- Pick the first successfully-parsed route dispatch time per batch
    MIN(
      CASE
        WHEN r.dispatch_time ~* '^\s*[0-9]{1,2}:[0-9]{2}\s*(AM|PM)?\s*$'
          THEN to_timestamp(trim(r.dispatch_time), 'HH12:MI AM')::time
        ELSE NULL
      END
    ) AS dt
  FROM batch_routes br
  JOIN routes r ON r.id = br.route_id
  WHERE r.dispatch_time IS NOT NULL
  GROUP BY br.batch_id
) sub
WHERE b.id = sub.batch_id
  AND b.dispatch_time IS NULL;


-- ══════════════════════════════════════════════════════════════════
-- 4. ROUTES — primary_batch_id (new direct FK)
-- ══════════════════════════════════════════════════════════════════
-- Nullable for backward-compat with any existing routes that have no
-- batch assigned yet. New route creations in the UI will enforce
-- non-null via zod; existing routes should be updated by the admin.
ALTER TABLE routes
  ADD COLUMN IF NOT EXISTS primary_batch_id uuid REFERENCES batches(id) ON DELETE SET NULL;

-- Seed from batch_routes — take the deterministic first row per route
-- (ordered by batch_routes.id).
UPDATE routes r
SET primary_batch_id = sub.batch_id
FROM (
  SELECT DISTINCT ON (route_id) route_id, batch_id
  FROM batch_routes
  ORDER BY route_id, id
) sub
WHERE r.id = sub.route_id
  AND r.primary_batch_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_routes_primary_batch
  ON routes (primary_batch_id)
  WHERE primary_batch_id IS NOT NULL AND deleted_at IS NULL;

-- NOTE: routes.dispatch_time is intentionally KEPT for now. The API
--       should read COALESCE(b.dispatch_time, r.dispatch_time) until
--       every route has a batch + every batch has a dispatch_time.
--       A future migration (0015+) will drop routes.dispatch_time.


-- ══════════════════════════════════════════════════════════════════
-- 5. SYSTEM SETTINGS — state / city / address_type / taluka seeds
-- ══════════════════════════════════════════════════════════════════
INSERT INTO system_settings (category, key, value) VALUES
  ('marketing', 'states',
   '["Karnataka","Kerala","Maharashtra"]'),

  ('marketing', 'address_types',
   '["Office","Residence"]'),

  -- Talukas in Haveri district — used by dealer + contractor address
  ('marketing', 'talukas',
   '["Byadgi","Hangal","Haveri","Hirekerur","Ranebennur","Rattihalli","Savanur","Shiggaon"]'),

  -- City list (32) from v1.4 spec
  ('marketing', 'cities',
   '["Adur","Akki Alur","Bankapur","Belagalpet","Bommnakatti","Byadagi","Chikkabasur","Chikkerur","Devaragudda","Gundur","Guttal","Halageri","Hangal","Haunsbhavi","Haveri","Hirekerur","Karjagi","Koda","Kumarpattanam","Kunimakkihalli","Masur","Motedennur","Neregal","Ranebennur","Rattihalli","Sangur","Savanur","Shiggoan","Tilavalli","Tippayikoppa","Tumminakatti","Yalagaccha","Yatnalli"]')
ON CONFLICT (category, key) DO NOTHING;


-- ══════════════════════════════════════════════════════════════════
-- Done.
-- New columns:
--   • dealers:     account_no, address_type, state, area, house_no,
--                  street, last_indent_at (+ trigger + index)
--   • contractors: bank_name, account_no, address_type, state, city,
--                  area, house_no, street, email, period_from,
--                  period_to, rate_per_km (+ index)
--   • batches:     dispatch_time (seeded from routes.dispatch_time)
--   • routes:      primary_batch_id (seeded from batch_routes)
--
-- New system_settings rows (category='marketing'):
--   states, address_types, talukas, cities
-- ══════════════════════════════════════════════════════════════════
