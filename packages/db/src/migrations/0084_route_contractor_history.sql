-- ════════════════════════════════════════════════════════════════════
-- Haveri Milk Union — Route contractor history
-- 0084_route_contractor_history.sql
--
-- Why:
--   routes.contractor_id only says who runs a route TODAY. Every report and
--   bill joined on it, so changing a route's contractor quietly moved the
--   old contractor's past route sheets, sales and DTC bill to the new one.
--
-- What:
--   • route_contractor_history — who held each route from / to which date
--                                (IST calendar days, to_date NULL = still).
--                                A row may carry contractor_id NULL: the
--                                route had no contractor in that spell.
--   • trigger on routes        — every insert, and every change of
--                                contractor_id (Masters → Contractors,
--                                Masters → Routes, anything else), closes the
--                                open row yesterday and opens a new one today.
--                                A second change on the same day replaces
--                                that day's row instead of leaving a 0-day one.
--   • route_contractor_on(route, date) — the contractor on a date; before
--                                the first row, the route's current one.
--   • dtc_bills.period_from / period_to — the days a bill covers. A month
--                                whose contractor changed has one bill per
--                                contractor; otherwise one bill for the month.
--                                UNIQUE (run_id, route_id) becomes
--                                UNIQUE (run_id, route_id, period_from).
--
-- Backfill: one open row per existing route, from 2000-01-01, with its
-- current contractor (we have no record of earlier changes). Existing bills
-- get their whole month as the period.
--
-- Idempotent: IF NOT EXISTS / OR REPLACE / guarded backfills.
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS route_contractor_history (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id       uuid NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  contractor_id  uuid REFERENCES contractors(id) ON DELETE SET NULL,
  -- Name at the time, so a later rename / delete does not rewrite history.
  contractor_name text,
  from_date      date NOT NULL,
  to_date        date,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (to_date IS NULL OR to_date >= from_date)
);
CREATE INDEX IF NOT EXISTS idx_route_contractor_history_route
  ON route_contractor_history (route_id, from_date);
CREATE UNIQUE INDEX IF NOT EXISTS uq_route_contractor_history_open
  ON route_contractor_history (route_id) WHERE to_date IS NULL;
CREATE INDEX IF NOT EXISTS idx_route_contractor_history_contractor
  ON route_contractor_history (contractor_id);

-- Backfill: every route without history gets one open row.
INSERT INTO route_contractor_history (route_id, contractor_id, contractor_name, from_date)
SELECT r.id, r.contractor_id, c.name, DATE '2000-01-01'
  FROM routes r
  LEFT JOIN contractors c ON c.id = r.contractor_id
 WHERE NOT EXISTS (SELECT 1 FROM route_contractor_history h WHERE h.route_id = r.id);


CREATE OR REPLACE FUNCTION trg_route_contractor_history() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  cname text;
  prev  route_contractor_history%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.contractor_id IS NOT DISTINCT FROM OLD.contractor_id THEN
    RETURN NEW;
  END IF;
  SELECT name INTO cname FROM contractors WHERE id = NEW.contractor_id;

  IF TG_OP = 'UPDATE' THEN
    -- A spell that started today is replaced, not closed at 0 days.
    DELETE FROM route_contractor_history
     WHERE route_id = NEW.id AND to_date IS NULL AND from_date >= today;
    UPDATE route_contractor_history SET to_date = today - 1
     WHERE route_id = NEW.id AND to_date IS NULL;
    -- Switched back to yesterday's contractor on the same day: reopen it.
    SELECT * INTO prev FROM route_contractor_history
     WHERE route_id = NEW.id ORDER BY from_date DESC LIMIT 1;
    IF FOUND AND prev.to_date = today - 1
       AND prev.contractor_id IS NOT DISTINCT FROM NEW.contractor_id THEN
      UPDATE route_contractor_history SET to_date = NULL WHERE id = prev.id;
      RETURN NEW;
    END IF;
  END IF;

  INSERT INTO route_contractor_history (route_id, contractor_id, contractor_name, from_date)
  VALUES (NEW.id, NEW.contractor_id, cname, today);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS route_contractor_history_ins ON routes;
CREATE TRIGGER route_contractor_history_ins
  AFTER INSERT ON routes
  FOR EACH ROW EXECUTE FUNCTION trg_route_contractor_history();
DROP TRIGGER IF EXISTS route_contractor_history_upd ON routes;
CREATE TRIGGER route_contractor_history_upd
  AFTER UPDATE OF contractor_id ON routes
  FOR EACH ROW EXECUTE FUNCTION trg_route_contractor_history();


-- The contractor of a route on a date. Before the route's first history
-- row (a route created after the date), its current contractor.
CREATE OR REPLACE FUNCTION route_contractor_on(p_route uuid, p_date date) RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    (SELECT h.contractor_id FROM route_contractor_history h
      WHERE h.route_id = p_route AND h.from_date <= p_date
        AND (h.to_date IS NULL OR h.to_date >= p_date)
      ORDER BY h.from_date DESC LIMIT 1),
    CASE WHEN NOT EXISTS (SELECT 1 FROM route_contractor_history h
                           WHERE h.route_id = p_route AND h.from_date <= p_date)
         THEN (SELECT r.contractor_id FROM routes r WHERE r.id = p_route) END
  )
$$;


-- ── DTC bills: one per contractor spell in the month ───────────────────
ALTER TABLE dtc_bills ADD COLUMN IF NOT EXISTS period_from date;
ALTER TABLE dtc_bills ADD COLUMN IF NOT EXISTS period_to   date;
UPDATE dtc_bills b
   SET period_from = r.bill_month,
       period_to   = (r.bill_month + interval '1 month - 1 day')::date
  FROM dtc_bill_runs r
 WHERE r.id = b.run_id AND b.period_from IS NULL;
ALTER TABLE dtc_bills ALTER COLUMN period_from SET NOT NULL;
ALTER TABLE dtc_bills ALTER COLUMN period_to   SET NOT NULL;

ALTER TABLE dtc_bills DROP CONSTRAINT IF EXISTS dtc_bills_run_id_route_id_key;
-- …and any other UNIQUE on exactly (run_id, route_id), whatever its name.
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT con.conname
      FROM pg_constraint con
     WHERE con.conrelid = 'dtc_bills'::regclass AND con.contype = 'u'
       AND (SELECT array_agg(a.attname::text ORDER BY a.attname)
              FROM unnest(con.conkey) k JOIN pg_attribute a
                ON a.attrelid = con.conrelid AND a.attnum = k) = ARRAY['route_id', 'run_id']
  LOOP
    EXECUTE format('ALTER TABLE dtc_bills DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dtc_bills_run_route_period_key') THEN
    -- Deferrable: a refresh may move two bills' periods past each other.
    ALTER TABLE dtc_bills ADD CONSTRAINT dtc_bills_run_route_period_key UNIQUE (run_id, route_id, period_from)
      DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;
