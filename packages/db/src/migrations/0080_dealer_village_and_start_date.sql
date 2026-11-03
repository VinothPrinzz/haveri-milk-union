-- ════════════════════════════════════════════════════════════════════
-- Haveri Milk Union — customer City/Village + agency start date
-- 0080_dealer_village_and_start_date.sql
--
-- Why:
--   • The customer master records the taluka (zone_id) and a fixed district
--     ('Haveri', see 0073), but not the city or village the agency trades
--     in. The union wants that on every customer, and a sales report
--     grouped by it.
--   • The Agency Report lists when each agency started and how many started
--     in a month. created_at is the day the row was typed (the 930 imported
--     dealers all share their import date), so the start date is its own
--     editable field. It is backfilled with the earlier of created_at (IST
--     day) and the agency's first order, which the office can correct from
--     the customer master.
--
-- What:
--   dealers.village            text, nullable — free text, matched
--                              case-/space-insensitively by the report.
--   dealers.agency_start_date  date NOT NULL DEFAULT IST today, after the
--                              backfill.
--
-- Apply MANUALLY on prod (src/apply-migration-0080.ts), BEFORE deploying the
-- API: the customer list and the new reports read both columns.
-- Idempotent; safe to re-run.
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE dealers ADD COLUMN IF NOT EXISTS village text;
ALTER TABLE dealers ADD COLUMN IF NOT EXISTS agency_start_date date;

UPDATE dealers d
   SET agency_start_date = LEAST(
         (d.created_at AT TIME ZONE 'Asia/Kolkata')::date,
         COALESCE((SELECT MIN(o.delivery_date) FROM orders o WHERE o.dealer_id = d.id),
                  (d.created_at AT TIME ZONE 'Asia/Kolkata')::date)
       )
 WHERE d.agency_start_date IS NULL;

ALTER TABLE dealers
  ALTER COLUMN agency_start_date SET DEFAULT ((now() AT TIME ZONE 'Asia/Kolkata')::date);
ALTER TABLE dealers
  ALTER COLUMN agency_start_date SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_dealers_agency_start_date
  ON dealers (agency_start_date) WHERE deleted_at IS NULL;

COMMENT ON COLUMN dealers.village IS
  'City / village the customer trades in (free text). Grouped case-insensitively by the City/Village sales report.';
COMMENT ON COLUMN dealers.agency_start_date IS
  'Day the agency started. Backfilled by 0080 from created_at / first order; editable in the customer master.';
