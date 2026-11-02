-- ════════════════════════════════════════════════════════════════════
-- Haveri Milk Union — DTC Billing (transport contractor monthly bills)
-- 0079_dtc_billing.sql
--
-- Why:
--   Every month the union pays each route's transport contractor (DTC):
--
--     KM basis    gross = days × km per day × rate per km
--     Trip basis  gross = days × rate per trip
--     Litre basis gross = litres/kg carried × rate per litre
--
--   plus other earnings (extra km, …), minus deductions (crate shortage,
--   short km, dues, security deposit, GPS, penalties, advances, TDS, …).
--   Marketing used to prepare this "Consolidated DTC Bill" by hand.
--
-- What (all new tables, prefix dtc_; nothing existing is rewritten):
--   • dtc_route_terms        — billing terms per route, versioned by
--                              effective_from (a rate revision is a new row,
--                              so old bills keep the rate they were paid at)
--   • dtc_crate_rates        — crate shortage rate, versioned by date
--   • dtc_recurring_charges  — monthly fixed deductions (GPS rent, …)
--   • dtc_security_deposits  — deposit plan per contractor (target, instalment)
--   • dtc_advances           — advances paid mid-month, recovered from a bill
--   • dtc_bill_runs          — one per month; the approval chain lives here
--   • dtc_bills              — one per route per month (figures snapshotted)
--   • dtc_bill_lines         — each earning / deduction on a bill
--   • dtc_payments           — what was paid against each bill
--   • dtc_events             — audit trail (who generated / edited / approved)
--   • contractors            — + IFSC, PAN and the TDS (194C) declaration
--   • system_settings        — category 'dtc'
--
-- Existing routes.rate_per_trip / total_km_per_day are copied into a first
-- terms version per route (effective 2020-01-01) so nothing has to be keyed
-- again. Those rows are marked "Imported" for Marketing to verify.
--
-- Idempotent — IF NOT EXISTS + ON CONFLICT DO NOTHING.
-- ════════════════════════════════════════════════════════════════════

-- ── Contractor bank + tax details ───────────────────────────────────
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS bank_name          text;
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS ifsc_code          text;
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS pan_number         text;
-- 'individual' (individual / HUF → 1% TDS) or 'other' (firm, company → 2%)
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS tds_entity_type    text NOT NULL DEFAULT 'individual';
-- Financial year of the latest "not more than 10 goods carriages"
-- declaration, e.g. '2026-27'. A valid declaration + PAN means no TDS.
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS tds_declaration_fy text;

DO $$ BEGIN
  ALTER TABLE contractors ADD CONSTRAINT contractors_tds_entity_type_check
    CHECK (tds_entity_type IN ('individual', 'other'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ── Route billing terms (versioned) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS dtc_route_terms (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id             uuid NOT NULL REFERENCES routes(id) ON DELETE RESTRICT,
  effective_from       date NOT NULL,
  -- false = the route is not billed from this date (contract ended, …)
  active               boolean NOT NULL DEFAULT true,
  billing_type         text NOT NULL CHECK (billing_type IN ('km', 'trip', 'litre')),
  -- ₹ per km / per trip / per litre-kg, depending on billing_type
  rate                 numeric(10, 3) NOT NULL DEFAULT 0 CHECK (rate >= 0),
  km_per_day           numeric(8, 2)  NOT NULL DEFAULT 0 CHECK (km_per_day >= 0),
  vehicle_capacity_mt  numeric(6, 2),
  vehicle_number       text,
  -- Contract (tender) details
  agreement_no         text,
  contract_start       date,
  contract_end         date,
  insulated            boolean NOT NULL DEFAULT false,
  -- The vehicle collects cash from dealers on this route
  cash_collection      boolean NOT NULL DEFAULT false,
  notes                text,
  created_by           uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (route_id, effective_from),
  CONSTRAINT dtc_route_terms_contract_check
    CHECK (contract_end IS NULL OR contract_start IS NULL OR contract_end >= contract_start)
);
CREATE INDEX IF NOT EXISTS idx_dtc_route_terms_route ON dtc_route_terms (route_id, effective_from DESC);


-- ── Crate shortage rate (versioned) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS dtc_crate_rates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  effective_from  date NOT NULL UNIQUE,
  rate            numeric(10, 2) NOT NULL CHECK (rate >= 0),
  notes           text,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);


-- ── Monthly fixed deductions per route (GPS rent, …) ────────────────
CREATE TABLE IF NOT EXISTS dtc_recurring_charges (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id        uuid NOT NULL REFERENCES routes(id) ON DELETE RESTRICT,
  head            text NOT NULL CHECK (head IN ('gps', 'other_deduction')),
  description     text NOT NULL,
  monthly_amount  numeric(10, 2) NOT NULL CHECK (monthly_amount > 0),
  from_month      date NOT NULL CHECK (extract(day FROM from_month) = 1),
  to_month        date CHECK (to_month IS NULL OR extract(day FROM to_month) = 1),
  active          boolean NOT NULL DEFAULT true,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dtc_recurring_months_check CHECK (to_month IS NULL OR to_month >= from_month)
);
CREATE INDEX IF NOT EXISTS idx_dtc_recurring_route ON dtc_recurring_charges (route_id);


-- ── Security deposit plan per contractor ────────────────────────────
-- Collected so far = opening_collected + every security_deposit line on a
-- bill of a live run. Refunded on exit.
CREATE TABLE IF NOT EXISTS dtc_security_deposits (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id       uuid NOT NULL UNIQUE REFERENCES contractors(id) ON DELETE RESTRICT,
  target_amount       numeric(12, 2) NOT NULL CHECK (target_amount > 0),
  monthly_instalment  numeric(12, 2) NOT NULL CHECK (monthly_instalment > 0),
  opening_collected   numeric(12, 2) NOT NULL DEFAULT 0 CHECK (opening_collected >= 0),
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'closed')),
  refunded_amount     numeric(12, 2) NOT NULL DEFAULT 0 CHECK (refunded_amount >= 0),
  refunded_on         date,
  refund_reference    text,
  notes               text,
  created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);


-- ── Advances paid to contractors, recovered from a month's bill ─────
CREATE TABLE IF NOT EXISTS dtc_advances (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id     uuid NOT NULL REFERENCES contractors(id) ON DELETE RESTRICT,
  route_id          uuid REFERENCES routes(id) ON DELETE SET NULL,   -- optional: recover from this route's bill
  paid_on           date NOT NULL,
  amount            numeric(12, 2) NOT NULL CHECK (amount > 0),
  mode              text NOT NULL CHECK (mode IN ('neft', 'rtgs', 'imps', 'upi', 'cheque', 'cash')),
  reference         text,
  recover_month     date NOT NULL CHECK (extract(day FROM recover_month) = 1),
  notes             text,
  cancelled_at      timestamptz,
  cancelled_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  cancel_reason     text,
  created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dtc_advances_contractor ON dtc_advances (contractor_id, recover_month);


-- ── Monthly bill run ────────────────────────────────────────────────
-- draft → submitted (prepared) → pre_audited → mktg_approved → approved.
-- Only a draft can be edited; "send back" returns it to draft. Approved
-- = locked: bills can be paid, nothing can be edited.
CREATE TABLE IF NOT EXISTS dtc_bill_runs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_month         date NOT NULL UNIQUE CHECK (extract(day FROM bill_month) = 1),
  status             text NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft', 'submitted', 'pre_audited', 'mktg_approved', 'approved')),
  -- 'total_earnings' | 'gross' — what cost per litre divides; frozen per run
  cost_basis         text NOT NULL DEFAULT 'total_earnings' CHECK (cost_basis IN ('total_earnings', 'gross')),
  generated_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  generated_at       timestamptz NOT NULL DEFAULT now(),
  submitted_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  submitted_at       timestamptz,
  pre_audited_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  pre_audited_at     timestamptz,
  mktg_approved_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  mktg_approved_at   timestamptz,
  approved_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at        timestamptz,
  -- Last "send back" comment, shown on the bill sheet until resubmitted
  returned_comment   text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);


-- ── One bill per route per month ────────────────────────────────────
CREATE TABLE IF NOT EXISTS dtc_bills (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id              uuid NOT NULL REFERENCES dtc_bill_runs(id) ON DELETE CASCADE,
  route_id            uuid NOT NULL REFERENCES routes(id) ON DELETE RESTRICT,
  route_code          text NOT NULL,
  route_name          text NOT NULL,
  contractor_id       uuid REFERENCES contractors(id) ON DELETE SET NULL,
  contractor_name     text,
  vehicle_number      text,
  vehicle_capacity_mt numeric(6, 2),
  -- Terms in force at month end (what the consolidated sheet prints).
  billing_type        text NOT NULL CHECK (billing_type IN ('km', 'trip', 'litre')),
  rate                numeric(10, 3) NOT NULL,
  km_per_day          numeric(8, 2) NOT NULL DEFAULT 0,
  -- One entry per terms version in force during the month (a mid-month
  -- rate revision gives two). Each: key, termsId, from, to, billingType,
  -- rate, kmPerDay, autoDays, daysOverride, qty, amount.
  segments            jsonb NOT NULL DEFAULT '[]'::jsonb,
  days                int NOT NULL DEFAULT 0,
  qty_litres          numeric(14, 3) NOT NULL DEFAULT 0,
  gross_amount        numeric(12, 2) NOT NULL DEFAULT 0,
  other_earnings      numeric(12, 2) NOT NULL DEFAULT 0,
  total_earnings      numeric(12, 2) NOT NULL DEFAULT 0,
  total_deductions    numeric(12, 2) NOT NULL DEFAULT 0,
  -- total_earnings − total_deductions (can be negative)
  net_amount          numeric(12, 2) NOT NULL DEFAULT 0,
  -- max(net, 0) — what is paid
  payable_amount      numeric(12, 2) NOT NULL DEFAULT 0,
  -- max(−net, 0) — recovered from the contractor's next bill
  carry_forward       numeric(12, 2) NOT NULL DEFAULT 0,
  cost_per_litre      numeric(10, 2) NOT NULL DEFAULT 0,
  cash_collection     boolean NOT NULL DEFAULT false,
  -- Auto lines the user removed ('head:sourceRef'); regeneration skips them
  suppressed_auto     text[] NOT NULL DEFAULT '{}',
  on_hold             boolean NOT NULL DEFAULT false,
  hold_reason         text,
  held_by             uuid REFERENCES users(id) ON DELETE SET NULL,
  held_at             timestamptz,
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, route_id)
);
CREATE INDEX IF NOT EXISTS idx_dtc_bills_contractor ON dtc_bills (contractor_id);
CREATE INDEX IF NOT EXISTS idx_dtc_bills_route ON dtc_bills (route_id);


-- ── Earnings / deductions on a bill ─────────────────────────────────
CREATE TABLE IF NOT EXISTS dtc_bill_lines (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id      uuid NOT NULL REFERENCES dtc_bills(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('earning', 'deduction')),
  head         text NOT NULL CHECK (head IN (
                 -- earnings
                 'extra_km', 'extra_trip', 'extra_litre', 'other_earning',
                 -- deductions
                 'crate', 'packet', 'km', 'dues', 'security_deposit', 'gps',
                 'penalty', 'advance', 'carry_forward', 'tds', 'other_deduction')),
  qty          numeric(12, 3),
  rate         numeric(10, 3),
  amount       numeric(12, 2) NOT NULL CHECK (amount >= 0),
  remarks      text,
  -- 'auto' lines are re-derived on regeneration; 'manual' lines are kept
  source       text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'auto')),
  -- advance id / deposit id / recurring charge id / source bill id
  source_ref   uuid,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dtc_bill_lines_bill ON dtc_bill_lines (bill_id);
CREATE INDEX IF NOT EXISTS idx_dtc_bill_lines_source ON dtc_bill_lines (head, source_ref) WHERE source_ref IS NOT NULL;


-- ── Payments against bills ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dtc_payments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id          uuid NOT NULL REFERENCES dtc_bills(id) ON DELETE RESTRICT,
  contractor_id    uuid REFERENCES contractors(id) ON DELETE SET NULL,
  amount           numeric(12, 2) NOT NULL CHECK (amount > 0),
  paid_on          date NOT NULL,
  mode             text NOT NULL CHECK (mode IN ('neft', 'rtgs', 'imps', 'upi', 'cheque', 'cash')),
  reference        text,           -- UTR / cheque number
  notes            text,
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  reversed_at      timestamptz,
  reversed_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  reverse_reason   text
);
CREATE INDEX IF NOT EXISTS idx_dtc_payments_bill ON dtc_payments (bill_id);
CREATE INDEX IF NOT EXISTS idx_dtc_payments_contractor ON dtc_payments (contractor_id, paid_on);
-- At most one live payment per bill (bills are paid in full).
CREATE UNIQUE INDEX IF NOT EXISTS uq_dtc_payments_live_bill
  ON dtc_payments (bill_id) WHERE reversed_at IS NULL;


-- ── Audit trail ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dtc_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id      uuid REFERENCES dtc_bill_runs(id) ON DELETE CASCADE,
  bill_id     uuid REFERENCES dtc_bills(id) ON DELETE CASCADE,
  action      text NOT NULL,
  detail      text,
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dtc_events_run ON dtc_events (run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dtc_events_bill ON dtc_events (bill_id, created_at DESC);


-- ── Settings (editable from DTC Billing → Route Billing Setup) ──────
INSERT INTO system_settings (category, key, value) VALUES
  ('dtc', 'cost_per_litre_basis', 'total_earnings'),
  ('dtc', 'tds_enabled',          'false'),
  ('dtc', 'signatures',
   '["Prepared by","Pre-Auditor","Field Staff","MO (Mktg)","Manager (Mktg)","Manager (Finance)"]')
ON CONFLICT (category, key) DO NOTHING;


-- ── Carry existing per-route pay into a first terms version ─────────
-- routes.rate_per_trip is "rate per km/trip"; routes with a daily km are
-- taken as KM basis, the rest as Trip basis.
INSERT INTO dtc_route_terms (route_id, effective_from, billing_type, rate, km_per_day, vehicle_number, notes)
SELECT r.id, DATE '2020-01-01',
       CASE WHEN COALESCE(r.total_km_per_day, 0) > 0 THEN 'km' ELSE 'trip' END,
       r.rate_per_trip, COALESCE(r.total_km_per_day, 0), c.vehicle_number,
       'Imported from route master — please verify'
  FROM routes r
  LEFT JOIN contractors c ON c.id = r.contractor_id
 WHERE r.deleted_at IS NULL
   AND r.code <> 'DEMO'
   AND COALESCE(r.rate_per_trip, 0) > 0
ON CONFLICT (route_id, effective_from) DO NOTHING;
