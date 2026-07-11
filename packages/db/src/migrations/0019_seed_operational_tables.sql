-- ══════════════════════════════════════════════════════════════════
-- Haveri Milk Union — Operational Tables Population Migration
-- 0019_seed_operational_tables.sql
--
-- Wipes prior mock / placeholder data from operational tables, then
-- repopulates them from the real PDF-derived datasets loaded by 0018.
--
-- Re-running this migration is SAFE: every run starts with a clean
-- delete pass and rebuilds the operational layer from scratch.
--
-- ┌─────────────────────────────────────────┐
-- │  Tables touched                           │
-- └─────────────────────────────────────────┘
--   1. zones                 → assert (real taluk data, not deleted)
--   2. time_windows          → assert
--   3. categories            → assert
--   4. batches               → assert + dispatch_time refresh
--   5. contractors           → DELETE 3 sample rows from 0004 +
--                              4 officer rows from prior 0019 runs;
--                              re-insert 4 officer-derived contractors
--   6. routes                → DELETE prior R1..R8; re-insert
--   7. batch_routes          → DELETE all; re-insert (8 × 3 = 24)
--   8. dealer_routes         → DELETE all; re-insert (one per dealer)
--   9. route_assignments     → DELETE today's; re-insert
--  10. fgs_stock_log         → DELETE today's; re-insert
--
-- ┌─────────────────────────────────────────┐
-- │  Foreign-key delete order (top → down)   │
-- └─────────────────────────────────────────┘
-- The cleanup pass walks DOWN the FK graph (children before parents),
-- so RESTRICT FKs never block a delete and CASCADE FKs never silently
-- remove rows we wanted to keep:
--
--   fgs_stock_log         (children of products/batches/users)
--   route_assignments     (RESTRICT child of routes)
--   route_sheets          (RESTRICT child of routes — defensive)
--   dealer_routes         (CASCADE child of routes — explicit for clarity)
--   batch_routes          (CASCADE child of routes/batches — explicit)
--     ↓ at this point all RESTRICT references to routes are gone
--   dealers.route_id NULL'd (SET NULL would handle this on delete, but
--     explicit avoids depending on FK side-effect order)
--   routes                (now safe to delete)
--   contractors (mock)    (routes already deleted, no FK left)
--
-- Order is enforced by sequential SQL — every DELETE either has no
-- live children pointing at it or is preceded by a child cleanup.
--
-- Run with: psql $DATABASE_URL -f 0019_seed_operational_tables.sql
-- ══════════════════════════════════════════════════════════════════

BEGIN;

-- ┌─────────────────────────────────────────┐
-- │  STEP 0 — System admin user              │
-- └─────────────────────────────────────────┘
-- fgs_stock_log.entered_by is NOT NULL referencing users(id). Insert
-- a placeholder super_admin if none exists. The password_hash is a
-- non-bcrypt sentinel — admin must reset via forgot-password flow.

INSERT INTO users (name, email, password_hash, role, active)
VALUES ('System Admin', 'admin@haverimilk.local',
        'PENDING-MUST-RESET-VIA-FORGOT-PASSWORD',
        'super_admin', true)
ON CONFLICT (email) DO NOTHING;


-- ══════════════════════════════════════════════════════════════════
-- PHASE 1 — CLEANUP (FK-safe, child → parent)
-- ══════════════════════════════════════════════════════════════════

-- ┌─────────────────────────────────────────┐
-- │  1.1 — fgs_stock_log (no children)       │
-- └─────────────────────────────────────────┘
-- Only today's entries; historical stock data is preserved.

DELETE FROM fgs_stock_log WHERE date = CURRENT_DATE;


-- ┌─────────────────────────────────────────┐
-- │  1.2 — route_assignments (RESTRICT→routes)│
-- └─────────────────────────────────────────┘
-- Must delete before routes. Only today's; history preserved.

DELETE FROM route_assignments WHERE date = CURRENT_DATE;


-- ┌─────────────────────────────────────────┐
-- │  1.3 — route_sheets (RESTRICT→routes)    │
-- └─────────────────────────────────────────┘
-- Defensive: clear any sheets that reference routes we're about to
-- delete. Empty in fresh installs; safe on re-runs.

DELETE FROM route_sheets
 WHERE route_id IN (
   SELECT id FROM routes
    WHERE code IN ('R1','R2','R3','R4','R5','R6','R7','R8')
 );


-- ┌─────────────────────────────────────────┐
-- │  1.4 — dealer_routes (CASCADE→routes)    │
-- └─────────────────────────────────────────┘
-- All entries — they're 100% derived from 0019, no manual edits to
-- preserve. Explicit DELETE (rather than relying on CASCADE) so the
-- row-count is reported.

DELETE FROM dealer_routes;


-- ┌─────────────────────────────────────────┐
-- │  1.5 — batch_routes (CASCADE→routes)     │
-- └─────────────────────────────────────────┘
-- Same reasoning — fully derived from 0019.

DELETE FROM batch_routes;


-- ┌─────────────────────────────────────────┐
-- │  1.6 — Clear dealers.route_id            │
-- └─────────────────────────────────────────┘
-- Belt-and-braces: even though dealers.route_id has ON DELETE SET
-- NULL, doing this explicitly before the route DELETE keeps the
-- next step's row-count meaningful.

UPDATE dealers SET route_id = NULL WHERE route_id IS NOT NULL;


-- ┌─────────────────────────────────────────┐
-- │  1.7 — routes                            │
-- └─────────────────────────────────────────┘
-- All 8 routes added by prior 0019 runs. RESTRICT children are gone
-- (steps 1.2, 1.3); SET NULL children clear themselves (dealers,
-- direct_sales, invoices); CASCADE children are gone (steps 1.4, 1.5).

DELETE FROM routes
 WHERE code IN ('R1','R2','R3','R4','R5','R6','R7','R8');


-- ┌─────────────────────────────────────────┐
-- │  1.8 — contractors (mock + prior 0019)   │
-- └─────────────────────────────────────────┘
-- Two cohorts to remove:
--   (a) The 3 sample contractors seeded by 0004 ('Karnataka Transport
--       Co.', 'Sree Logistics', 'Raghavendra Transports') — these are
--       hand-typed mock data, not from any real source.
--   (b) The 4 officer-contractors (CTR-OFF-001..004) from prior 0019
--       runs — we'll re-insert these in PHASE 2 with fresh zone
--       resolution.
-- All FK references from routes / route_sheets are SET NULL on delete.

DELETE FROM contractors WHERE code LIKE 'CTR-OFF-%';
DELETE FROM contractors
 WHERE phone IN ('9876500001', '9876500002', '9876500003')
   AND name IN ('Karnataka Transport Co.', 'Sree Logistics',
                'Raghavendra Transports');


-- ══════════════════════════════════════════════════════════════════
-- PHASE 2 — POPULATE
-- ══════════════════════════════════════════════════════════════════

-- ┌─────────────────────────────────────────┐
-- │  2.1 — zones (assert; real taluk data)   │
-- └─────────────────────────────────────────┘
-- The 8 taluks of Haveri district. Real geographic data, NOT mock —
-- left intact across re-runs. ON CONFLICT keeps existing rows.

INSERT INTO zones (name, slug, icon, color, active) VALUES
  ('Haveri',     'haveri',     '🏛️', '#1448CC', true),
  ('Ranebennur', 'ranebennur', '🌎', '#D97706', true),
  ('Savanur',    'savanur',    '🏘️', '#16A34A', true),
  ('Byadgi',     'byadgi',     '🌿', '#DC2626', true),
  ('Hirekerur',  'hirekerur',  '🏡', '#9333EA', true),
  ('Hangal',     'hangal',     '🌿', '#0891B2', true),
  ('Shiggaon',   'shiggaon',   '🌾', '#7C3AED', true),
  ('Rattihalli', 'rattihalli', '🌳', '#059669', true)
ON CONFLICT (slug) DO NOTHING;


-- ┌─────────────────────────────────────────┐
-- │  2.2 — time_windows (assert)             │
-- └─────────────────────────────────────────┘
-- Default 06:00–08:00 with 20-min warning for most zones; Savanur
-- runs 06:30–08:30 per existing 0001 seed.

INSERT INTO time_windows (zone_id, open_time, warning_minutes, close_time)
SELECT z.id, '06:00'::time, 20, '08:00'::time
FROM zones z
WHERE z.slug IN ('haveri','ranebennur','byadgi','hirekerur','hangal',
                 'shiggaon','rattihalli')
ON CONFLICT (zone_id) DO NOTHING;

INSERT INTO time_windows (zone_id, open_time, warning_minutes, close_time)
SELECT z.id, '06:30'::time, 15, '08:30'::time
FROM zones z
WHERE z.slug = 'savanur'
ON CONFLICT (zone_id) DO NOTHING;


-- ┌─────────────────────────────────────────┐
-- │  2.3 — categories (assert)               │
-- └─────────────────────────────────────────┘
-- 8 product categories used by 0018 product loader.

INSERT INTO categories (name, icon, sort_order) VALUES
  ('Milk',       '🥛', 1),
  ('Curd',       '🫙', 2),
  ('Butter',     '🧈', 3),
  ('Ghee',       '🫙', 4),
  ('Paneer',     '🧀', 5),
  ('Flavoured',  '🍫', 6),
  ('Beverages',  '🥤', 7),
  ('Sweets',     '🍮', 8)
ON CONFLICT (name) DO NOTHING;


-- ┌─────────────────────────────────────────┐
-- │  2.4 — batches (assert + dispatch_time)  │
-- └─────────────────────────────────────────┘
-- 3 standard delivery batches. The text `timing` was seeded in 0004;
-- we add the machine-readable `dispatch_time` (column from 0013).

INSERT INTO batches (batch_number, name, which_batch, timing) VALUES
  ('BT01', 'Morning Batch',   'Morning',   '5:00 AM - 8:00 AM'),
  ('BT02', 'Afternoon Batch', 'Afternoon', '12:00 PM - 2:00 PM'),
  ('BT03', 'Evening Batch',   'Evening',   '4:00 PM - 6:00 PM')
ON CONFLICT (batch_number) WHERE deleted_at IS NULL DO NOTHING;

UPDATE batches SET dispatch_time = '05:30'::time
 WHERE batch_number = 'BT01';
UPDATE batches SET dispatch_time = '12:30'::time
 WHERE batch_number = 'BT02';
UPDATE batches SET dispatch_time = '16:30'::time
 WHERE batch_number = 'BT03';


-- ┌─────────────────────────────────────────┐
-- │  2.5 — contractors (officer-derived)     │
-- └─────────────────────────────────────────┘
-- One contractor per unique sales officer in the agent PDF. Their
-- `zone_id` is the zone where they manage the most dealers (a tie
-- is resolved deterministically via ORDER BY count DESC, then
-- zone slug).

DO $$
DECLARE
  v_officer_codes CONSTANT text[] := ARRAY[
    'CTR-OFF-001', 'CTR-OFF-002', 'CTR-OFF-003', 'CTR-OFF-004'
  ];
  v_officer_names CONSTANT text[] := ARRAY[
    'RAJU DASAR', 'SACHIN HARAMANAGATTI', 'PRAVEEN JADAR', 'SATISH JADAR'
  ];
  i int;
  v_zone_id uuid;
BEGIN
  FOR i IN 1..array_length(v_officer_codes, 1) LOOP
    SELECT d.zone_id INTO v_zone_id
    FROM dealers d
    WHERE d.officer_name = v_officer_names[i]
      AND d.deleted_at IS NULL
    GROUP BY d.zone_id
    ORDER BY count(*) DESC, d.zone_id
    LIMIT 1;

    INSERT INTO contractors (code, name, phone, zone_id, address, active)
    VALUES (
      v_officer_codes[i],
      v_officer_names[i],
      'PENDING-' || v_officer_codes[i],
      v_zone_id,
      'Field Sales Officer — Haveri Milk Union',
      true
    );
  END LOOP;
END $$;


-- ┌─────────────────────────────────────────┐
-- │  2.6 — routes (one per zone)             │
-- └─────────────────────────────────────────┘
-- R1..R8, each tied to one zone. contractor_id = the officer who
-- manages the most dealers in that zone (NULL if zone has no
-- assigned officers yet). primary_batch_id = BT01 Morning.

DO $$
DECLARE
  v_codes CONSTANT text[] := ARRAY[
    'R1','R2','R3','R4','R5','R6','R7','R8'
  ];
  v_zones CONSTANT text[] := ARRAY[
    'haveri','hangal','byadgi','hirekerur',
    'ranebennur','savanur','shiggaon','rattihalli'
  ];
  v_names CONSTANT text[] := ARRAY[
    'Haveri Town Route','Hangal Route','Byadgi Route','Hirekerur Route',
    'Ranebennur Route','Savanur Route','Shiggaon Route','Rattihalli Route'
  ];
  i int;
  v_zone_id uuid;
  v_batch_id uuid;
  v_contractor_id uuid;
BEGIN
  SELECT id INTO v_batch_id FROM batches WHERE batch_number = 'BT01';

  FOR i IN 1..array_length(v_codes, 1) LOOP
    SELECT id INTO v_zone_id FROM zones WHERE slug = v_zones[i];

    SELECT c.id INTO v_contractor_id
    FROM contractors c
    JOIN dealers d ON d.officer_name = c.name AND d.zone_id = v_zone_id
    WHERE c.code LIKE 'CTR-OFF-%'
      AND c.deleted_at IS NULL
      AND d.deleted_at IS NULL
    GROUP BY c.id
    ORDER BY count(d.id) DESC, c.id
    LIMIT 1;

    INSERT INTO routes (code, name, zone_id, contractor_id,
                        primary_batch_id, stops, active, dispatch_time)
    VALUES (v_codes[i], v_names[i], v_zone_id, v_contractor_id,
            v_batch_id, 0, true, '5:30 AM');
  END LOOP;
END $$;


-- ┌─────────────────────────────────────────┐
-- │  2.7 — batch_routes (full cross product) │
-- └─────────────────────────────────────────┘
-- Every route runs in every batch. UNIQUE constraint on
-- (batch_id, route_id) plus the cleanup in 1.5 makes this a clean
-- cross product — no conflicts possible.

INSERT INTO batch_routes (batch_id, route_id)
SELECT b.id, r.id
FROM batches b
CROSS JOIN routes r
WHERE r.deleted_at IS NULL
  AND r.code IN ('R1','R2','R3','R4','R5','R6','R7','R8');


-- ┌─────────────────────────────────────────┐
-- │  2.8 — dealer_routes + dealers.route_id  │
-- └─────────────────────────────────────────┘
-- Every active dealer is linked to its zone's route as primary.
-- The unique partial index uq_dealer_routes_primary enforces one
-- primary per dealer at the DB level — the cleanup in 1.4 guarantees
-- no leftover primary flags clash here.

UPDATE dealers d
SET route_id = r.id
FROM routes r
WHERE r.zone_id = d.zone_id
  AND r.deleted_at IS NULL
  AND d.deleted_at IS NULL
  AND d.route_id IS NULL;

INSERT INTO dealer_routes (dealer_id, route_id, is_primary)
SELECT d.id, r.id, true
FROM dealers d
JOIN routes r ON r.zone_id = d.zone_id
WHERE r.deleted_at IS NULL
  AND d.deleted_at IS NULL;


-- ┌─────────────────────────────────────────┐
-- │  2.9 — route_assignments (today)         │
-- └─────────────────────────────────────────┘
-- One placeholder dispatch per route for today. dealer_count is
-- computed from the dealer_routes junction we just populated.

INSERT INTO route_assignments (route_id, date, departure_time,
                               dealer_count, item_count, status)
SELECT r.id,
       CURRENT_DATE,
       '05:30'::time,
       (SELECT count(*)::int FROM dealer_routes dr
         WHERE dr.route_id = r.id AND dr.is_primary = true),
       0,
       'pending'::dispatch_status
FROM routes r
WHERE r.deleted_at IS NULL;


-- ┌─────────────────────────────────────────┐
-- │  2.10 — fgs_stock_log (today)            │
-- └─────────────────────────────────────────┘
-- One row per active product for today, with all stock counters at 0.
-- entered_by = the system_admin we seeded in STEP 0; batch_id = BT01.

DO $$
DECLARE
  v_admin_id uuid;
  v_batch_id uuid;
BEGIN
  SELECT id INTO v_admin_id FROM users
   WHERE email = 'admin@haverimilk.local' LIMIT 1;
  SELECT id INTO v_batch_id FROM batches
   WHERE batch_number = 'BT01' LIMIT 1;

  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'System admin not found — STEP 0 must run first';
  END IF;

  INSERT INTO fgs_stock_log (product_id, date, opening, received,
                             dispatched, wastage, closing,
                             entered_by, batch_id)
  SELECT p.id, CURRENT_DATE, 0, 0, 0, 0, 0, v_admin_id, v_batch_id
  FROM products p
  WHERE p.deleted_at IS NULL;
END $$;


-- ══════════════════════════════════════════════════════════════════
-- PHASE 3 — VERIFICATION
-- ══════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_zones        int;
  v_time_windows int;
  v_categories   int;
  v_batches      int;
  v_contractors  int;
  v_officer_contractors int;
  v_routes       int;
  v_batch_routes int;
  v_dealer_routes int;
  v_route_assignments int;
  v_fgs_stock_log int;
  v_orphan_dealers int;
  v_orphan_routes int;
  v_mock_left int;
BEGIN
  SELECT count(*) INTO v_zones        FROM zones;
  SELECT count(*) INTO v_time_windows FROM time_windows;
  SELECT count(*) INTO v_categories   FROM categories WHERE deleted_at IS NULL;
  SELECT count(*) INTO v_batches      FROM batches    WHERE deleted_at IS NULL;
  SELECT count(*) INTO v_contractors  FROM contractors WHERE deleted_at IS NULL;
  SELECT count(*) INTO v_officer_contractors FROM contractors
   WHERE code LIKE 'CTR-OFF-%' AND deleted_at IS NULL;
  SELECT count(*) INTO v_routes       FROM routes     WHERE deleted_at IS NULL;
  SELECT count(*) INTO v_batch_routes FROM batch_routes;
  SELECT count(*) INTO v_dealer_routes FROM dealer_routes;
  SELECT count(*) INTO v_route_assignments
    FROM route_assignments WHERE date = CURRENT_DATE;
  SELECT count(*) INTO v_fgs_stock_log
    FROM fgs_stock_log WHERE date = CURRENT_DATE;

  -- FK orphan checks
  SELECT count(*) INTO v_orphan_dealers
   FROM dealers WHERE deleted_at IS NULL AND route_id IS NULL;

  SELECT count(*) INTO v_orphan_routes
   FROM routes r
   WHERE r.deleted_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM zones z WHERE z.id = r.zone_id);

  -- Confirm mock contractors are gone
  SELECT count(*) INTO v_mock_left FROM contractors
   WHERE phone IN ('9876500001','9876500002','9876500003')
     AND deleted_at IS NULL;

  RAISE NOTICE '════════════════════════════════════════════════════════';
  RAISE NOTICE 'Operational Tables Population Summary';
  RAISE NOTICE '════════════════════════════════════════════════════════';
  RAISE NOTICE '   zones                : % (expected 8)',     v_zones;
  RAISE NOTICE '   time_windows         : % (expected 8)',     v_time_windows;
  RAISE NOTICE '   categories           : % (expected 8)',     v_categories;
  RAISE NOTICE '   batches              : % (expected 3)',     v_batches;
  RAISE NOTICE '   contractors total    : % (expected 4)',     v_contractors;
  RAISE NOTICE '   officer-contractors  : % (expected 4)',     v_officer_contractors;
  RAISE NOTICE '   routes               : % (expected 8)',     v_routes;
  RAISE NOTICE '   batch_routes         : % (expected 24)',    v_batch_routes;
  RAISE NOTICE '   dealer_routes        : % (expected ~836)',  v_dealer_routes;
  RAISE NOTICE '   route_assignments    : % (expected 8)',     v_route_assignments;
  RAISE NOTICE '   fgs_stock_log        : % (expected ~296)',  v_fgs_stock_log;
  RAISE NOTICE '   ──────────────────────────────────────';
  RAISE NOTICE '   dealers without route: % (must be 0)',      v_orphan_dealers;
  RAISE NOTICE '   routes w/orphan zone : % (must be 0)',      v_orphan_routes;
  RAISE NOTICE '   mock contractors left: % (must be 0)',      v_mock_left;
  RAISE NOTICE '════════════════════════════════════════════════════════';

  IF v_zones      <> 8 THEN RAISE EXCEPTION 'zones count wrong: %',      v_zones;      END IF;
  IF v_routes     <> 8 THEN RAISE EXCEPTION 'routes count wrong: %',     v_routes;     END IF;
  IF v_batch_routes <> 24 THEN RAISE EXCEPTION 'batch_routes count wrong: %', v_batch_routes; END IF;
  IF v_orphan_dealers > 0 THEN
    RAISE EXCEPTION '% active dealers have no route_id — aborting', v_orphan_dealers;
  END IF;
  IF v_orphan_routes > 0 THEN
    RAISE EXCEPTION '% routes reference a missing zone — aborting', v_orphan_routes;
  END IF;
  IF v_mock_left > 0 THEN
    RAISE EXCEPTION '% mock contractors still present — cleanup failed', v_mock_left;
  END IF;
END $$;

COMMIT;

-- ══════════════════════════════════════════════════════════════════
-- Migration 0019 complete. Loaded:
-- ✓ 1 system_admin user (must reset password before login)
-- ✓ 8 zones, 8 time_windows, 8 categories, 3 batches asserted
-- ✓ Removed 3 sample contractors from 0004 + any prior 0019 inserts
-- ✓ 4 officer-contractors (CTR-OFF-001..004) re-inserted from PDF data
-- ✓ 8 routes (R1..R8), one per zone, linked to dominant officer
-- ✓ 24 batch_routes (every route × every batch)
-- ✓ ~836 dealer_routes + dealers.route_id backfilled
-- ✓ 8 route_assignments for today
-- ✓ ~296 fgs_stock_log entries for today (opening = 0)
--
-- Foreign-key cleanup order: fgs_stock_log → route_assignments →
-- route_sheets → dealer_routes → batch_routes → routes → contractors
-- (children before parents, RESTRICT FKs cleared first)
-- ══════════════════════════════════════════════════════════════════
