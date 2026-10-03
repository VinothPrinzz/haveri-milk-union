-- ═══════════════════════════════════════════════════════════════════
-- 0073_district_haveri_only.sql
--
-- dealers.city is labelled "District" everywhere it surfaces (customer
-- master, invoice header, dealer statement). It was never populated with
-- districts: the values were TALUKA names — Ranebennur, Shiggaon, Hanagal,
-- Hirekerur, Savanur, Byadgi, Rattihalli — all of which are talukas *inside*
-- Haveri district, and all of which disagreed with the dealer's real taluka
-- (zones.name via d.zone_id) for 172 dealers. The union trades in one
-- district only, so the field is now a constant and the taluka is the
-- address column that actually varies.
--
--   • every dealer's district becomes 'Haveri'
--   • the old values are kept in backup_district.dealers_city_20260813
--     (nothing is lost — the real taluka was already on d.zone_id, which
--     is NOT NULL for all 930 dealers)
--   • the pickable district list collapses to ["Haveri"] so the customer
--     and contractor forms cannot reintroduce another one
-- ═══════════════════════════════════════════════════════════════════

BEGIN;

-- 1. Snapshot what we are about to overwrite.
CREATE SCHEMA IF NOT EXISTS backup_district;

CREATE TABLE IF NOT EXISTS backup_district.dealers_city_20260813 AS
  SELECT d.id,
         d.code,
         d.name,
         d.city    AS old_city,
         d.zone_id,
         z.name    AS zone_name,
         now()     AS captured_at
    FROM dealers d
    LEFT JOIN zones z ON z.id = d.zone_id;

-- 2. One district, every dealer (soft-deleted rows included, so a restored
--    dealer never comes back with a stale district).
UPDATE dealers
   SET city = 'Haveri', updated_at = now()
 WHERE city IS DISTINCT FROM 'Haveri';

ALTER TABLE dealers ALTER COLUMN city SET DEFAULT 'Haveri';

-- 3. Contractors carry the same "District" field on their form. Their
--    values are all blank today; give new rows the same constant.
ALTER TABLE contractors ALTER COLUMN city SET DEFAULT 'Haveri';

-- 4. Collapse the pickable district list. This is the only list the
--    customer / contractor "District" selects read.
UPDATE system_settings
   SET value = '["Haveri"]', updated_at = now()
 WHERE category = 'marketing' AND key = 'cities';

COMMIT;
