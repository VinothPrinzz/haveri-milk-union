-- ════════════════════════════════════════════════════════════════════
-- Haveri Milk Union — Promote Sales Officers to a dedicated table
-- 0044_officers_table.sql
--
-- 0043 modelled officers as `users` rows (role='officer') linked to
-- talukas via zones.officer_user_id. This migration promotes them to a
-- first-class `officers` table, repoints zones.officer_id at it, swaps the
-- dealer officer trigger over, and removes the now-unneeded users-based
-- artifacts (the officer users + zones.officer_user_id column).
--
-- NOTE: officers here are distinct from orders.officer_id /
-- direct_sales.officer_id, which record the staff *user* who processed a
-- sale.
--
-- Fully idempotent and tolerant of databases that never had the 0043
-- users-based artifacts (every step is IF EXISTS / IF NOT EXISTS / no-op).
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Officers table ──
CREATE TABLE IF NOT EXISTS officers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  phone      text,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Unique name → lets the seed below upsert idempotently.
CREATE UNIQUE INDEX IF NOT EXISTS officers_name_unique ON officers (name);

-- ── 2. Officer roster ──
INSERT INTO officers (name) VALUES
  ('Sachin Haramagatti'),
  ('Shashikumar Bilekudiri'),
  ('Raju Dasar'),
  ('Praveen Jadar'),
  ('Shivaraj Halavalli')
ON CONFLICT (name) DO NOTHING;

-- ── 3. Add zone → officer link (officers) ──
ALTER TABLE zones
  ADD COLUMN IF NOT EXISTS officer_id uuid REFERENCES officers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_zones_officer ON zones (officer_id);

-- ── 4. Assign officers to talukas (by slug — stable, deterministic) ──
UPDATE zones z SET officer_id = o.id
FROM officers o
WHERE o.name = 'Sachin Haramagatti'     AND z.slug = 'byadgi';

UPDATE zones z SET officer_id = o.id
FROM officers o
WHERE o.name = 'Shashikumar Bilekudiri' AND z.slug = 'hangal';

UPDATE zones z SET officer_id = o.id
FROM officers o
WHERE o.name = 'Raju Dasar'             AND z.slug = 'haveri';

UPDATE zones z SET officer_id = o.id
FROM officers o
WHERE o.name = 'Praveen Jadar'          AND z.slug IN ('hirekerur', 'rattihalli');

UPDATE zones z SET officer_id = o.id
FROM officers o
WHERE o.name = 'Shivaraj Halavalli'     AND z.slug IN ('savanur', 'shiggaon');

-- ── 5. Re-point the dealer officer trigger at the officers table ──
-- Replacing the function before dropping the old column means the trigger
-- no longer references officer_user_id by the time it disappears.
CREATE OR REPLACE FUNCTION dealers_set_officer_from_zone()
RETURNS trigger AS $$
BEGIN
  SELECT o.name INTO NEW.officer_name
  FROM zones z
  LEFT JOIN officers o ON o.id = z.officer_id
  WHERE z.id = NEW.zone_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_dealers_officer_from_zone ON dealers;
CREATE TRIGGER trg_dealers_officer_from_zone
  BEFORE INSERT OR UPDATE OF zone_id ON dealers
  FOR EACH ROW
  EXECUTE FUNCTION dealers_set_officer_from_zone();

-- ── 6. Re-backfill dealers.officer_name from the new mapping ──
-- Values are unchanged (same names), but keeps everything consistent and
-- repairs any rows touched between 0043 and this migration.
UPDATE dealers d
SET officer_name = (
      SELECT o.name FROM zones z
      LEFT JOIN officers o ON o.id = z.officer_id
      WHERE z.id = d.zone_id
    ),
    updated_at = now()
WHERE d.deleted_at IS NULL
  AND d.officer_name IS DISTINCT FROM (
      SELECT o.name FROM zones z
      LEFT JOIN officers o ON o.id = z.officer_id
      WHERE z.id = d.zone_id
    );

-- ── 7. Remove the unneeded 0043 users-based artifacts ──
DROP INDEX IF EXISTS idx_zones_officer_user;
ALTER TABLE zones DROP COLUMN IF EXISTS officer_user_id;

-- Delete the officer users created by 0043. Safe: nothing else references
-- them — orders.officer_id / direct_sales.officer_id point at staff admin
-- users, and these placeholder accounts (password '!') never processed
-- sales. Scoped to the 5 seeded usernames so real staff are untouched.
DELETE FROM users
WHERE role = 'officer'
  AND username IN (
    'sachin.haramagatti', 'shashikumar.bilekudiri', 'raju.dasar',
    'praveen.jadar', 'shivaraj.halavalli'
  );

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- Done. After this:
--   • officers table holds the field-officer roster.
--   • zones.officer_id links each taluka to its officer (officer_user_id
--     and its index are dropped).
--   • dealers_set_officer_from_zone trigger derives officer_name from
--     zones → officers on every write.
--   • The 0043 placeholder officer users are removed from `users`.
-- ════════════════════════════════════════════════════════════════════
