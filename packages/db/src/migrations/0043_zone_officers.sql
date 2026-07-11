-- ════════════════════════════════════════════════════════════════════
-- Haveri Milk Union — Sales Officers ↔ Taluka (Zone) Assignment
-- 0043_zone_officers.sql
--
-- NOTE: this version models officers as `users` rows (role = 'officer')
-- linked to talukas via zones.officer_user_id. Migration 0044 supersedes
-- it by promoting officers to a dedicated `officers` table. This file is
-- kept as-applied so the migration history is reproducible; do not edit.
--
-- Assignment (by zone slug):
--   byadgi     → Sachin Haramagatti
--   hangal     → Shashikumar Bilekudiri
--   haveri     → Raju Dasar
--   hirekerur  → Praveen Jadar
--   rattihalli → Praveen Jadar
--   savanur    → Shivaraj Halavalli
--   shiggaon   → Shivaraj Halavalli
--   (ranebennur left unassigned — no officer provided)
--
-- Idempotent — safe to re-run.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Officer roster (users with role = 'officer') ──
-- password_hash is NOT NULL; these accounts are for assignment/reporting
-- and are not expected to log in, so we store a non-matchable placeholder
-- ('!' is not a valid bcrypt hash). The ON CONFLICT target repeats the
-- `WHERE deleted_at IS NULL` predicate to match the partial unique index
-- `users_username_unique` (migration 0024) so re-runs are safe.
INSERT INTO users (name, username, email, password_hash, role, active) VALUES
  ('Sachin Haramagatti',     'sachin.haramagatti',     'sachin.haramagatti@haverimunion.coop',     '!', 'officer', true),
  ('Shashikumar Bilekudiri', 'shashikumar.bilekudiri', 'shashikumar.bilekudiri@haverimunion.coop', '!', 'officer', true),
  ('Raju Dasar',             'raju.dasar',             'raju.dasar@haverimunion.coop',             '!', 'officer', true),
  ('Praveen Jadar',          'praveen.jadar',          'praveen.jadar@haverimunion.coop',          '!', 'officer', true),
  ('Shivaraj Halavalli',     'shivaraj.halavalli',     'shivaraj.halavalli@haverimunion.coop',     '!', 'officer', true)
ON CONFLICT (username) WHERE deleted_at IS NULL DO NOTHING;

-- ── 2. Add zone → officer link ──
-- ON DELETE SET NULL: removing an officer unassigns their talukas rather
-- than blocking the delete (mirrors dealers.route_id behaviour).
ALTER TABLE zones
  ADD COLUMN IF NOT EXISTS officer_user_id uuid REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_zones_officer_user ON zones (officer_user_id);

-- ── 3. Assign officers to talukas (by slug — slugs are stable) ──
UPDATE zones z SET officer_user_id = u.id
FROM users u
WHERE u.username = 'sachin.haramagatti'     AND z.slug = 'byadgi';

UPDATE zones z SET officer_user_id = u.id
FROM users u
WHERE u.username = 'shashikumar.bilekudiri' AND z.slug = 'hangal';

UPDATE zones z SET officer_user_id = u.id
FROM users u
WHERE u.username = 'raju.dasar'             AND z.slug = 'haveri';

UPDATE zones z SET officer_user_id = u.id
FROM users u
WHERE u.username = 'praveen.jadar'          AND z.slug IN ('hirekerur', 'rattihalli');

UPDATE zones z SET officer_user_id = u.id
FROM users u
WHERE u.username = 'shivaraj.halavalli'     AND z.slug IN ('savanur', 'shiggaon');

-- ── 4. Backfill existing customers' officer from their taluka ──
UPDATE dealers d
SET officer_name = (
      SELECT u.name FROM zones z
      LEFT JOIN users u ON u.id = z.officer_user_id
      WHERE z.id = d.zone_id
    ),
    updated_at = now()
WHERE d.deleted_at IS NULL
  AND d.officer_name IS DISTINCT FROM (
      SELECT u.name FROM zones z
      LEFT JOIN users u ON u.id = z.officer_user_id
      WHERE z.id = d.zone_id
    );

-- ── 5. Enforce officer = taluka's officer on every write ──
CREATE OR REPLACE FUNCTION dealers_set_officer_from_zone()
RETURNS trigger AS $$
BEGIN
  SELECT u.name INTO NEW.officer_name
  FROM zones z
  LEFT JOIN users u ON u.id = z.officer_user_id
  WHERE z.id = NEW.zone_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_dealers_officer_from_zone ON dealers;
CREATE TRIGGER trg_dealers_officer_from_zone
  BEFORE INSERT OR UPDATE OF zone_id ON dealers
  FOR EACH ROW
  EXECUTE FUNCTION dealers_set_officer_from_zone();

COMMIT;
