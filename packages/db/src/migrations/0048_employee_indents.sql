-- ════════════════════════════════════════════════════════════════════
-- Haveri Milk Union — Employee Credit + Standing Indents
-- 0048_employee_indents.sql
--
-- Why:
--   Employees (the `employees` master from 0026) need the same daily
--   auto-placed indent flow that dealers have — but employees have NO
--   app login, so the whole flow is admin/worker-driven. They also get a
--   credit limit (finance-managed) and their indents are priced at the
--   employee-subsidy rate (employee_subsidy_rules), not full MRP.
--
--   We deliberately keep this a SEPARATE, parallel subsystem rather than
--   overloading dealer-keyed `orders`/`dealer_ledger`/finance reports:
--     • employee_standing_indents — per-employee per-product template
--     • employee_orders / _items  — the materialized daily indent
--     • employee_ledger           — credit tracking (mirror dealer_ledger)
--   and two new columns on `employees` (credit_limit, opening_balance).
--
--   Pricing: only products with an ACTIVE row in employee_subsidy_rules
--   are eligible; unit_price = base_price × (1 − subsidy%) + GST. This
--   matches the existing POST /direct-sales/employee-subsidy maths.
--
--   Over-limit behaviour: the worker / admin confirm parks an over-limit
--   indent as status='payment_required' (a finance "release" then places
--   it). No payment app flow exists for employees.
--
-- Idempotent — safe to re-run.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Credit columns on employees ───────────────────────────────────
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS credit_limit     numeric(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS opening_balance  numeric(14, 2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN employees.credit_limit IS
  'Finance-managed credit ceiling for employee standing indents (INR).';
COMMENT ON COLUMN employees.opening_balance IS
  'Opening balance for the employee credit ledger (INR, signed; negative = owes).';


-- ── 2. employee_standing_indents — per-employee template ─────────────
-- One row per (employee, product). Mirror of dealer_standing_indents.
-- Toggling out of the template is active=false (preserves default_qty).
CREATE TABLE IF NOT EXISTS employee_standing_indents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id  uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  product_id   uuid NOT NULL REFERENCES products(id)  ON DELETE RESTRICT,
  default_qty  integer NOT NULL DEFAULT 0 CHECK (default_qty >= 0),
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_standing_indents_emp_product
  ON employee_standing_indents (employee_id, product_id);
CREATE INDEX IF NOT EXISTS idx_employee_standing_indents_active
  ON employee_standing_indents (employee_id)
  WHERE active = true AND default_qty > 0;


-- ── 3. employee_orders — the materialized daily indent ───────────────
-- Mirror of the subset of `orders` we use. status reuses order_status
-- (we only ever use draft / payment_required / confirmed / cancelled).
CREATE TABLE IF NOT EXISTS employee_orders (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id          uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  route_id             uuid REFERENCES routes(id) ON DELETE SET NULL,
  status               order_status NOT NULL DEFAULT 'draft',
  payment_mode         payment_mode NOT NULL DEFAULT 'credit',
  subtotal             numeric(14, 2) NOT NULL DEFAULT 0,
  total_gst            numeric(14, 2) NOT NULL DEFAULT 0,
  grand_total          numeric(14, 2) NOT NULL DEFAULT 0,
  item_count           integer NOT NULL DEFAULT 0,
  delivery_date        date NOT NULL,
  confirmed_at         timestamptz,
  cancelled_at         timestamptz,
  cancellation_reason  text,
  placed_by            uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
-- At most one editable draft per (employee, delivery_date) — the
-- materializer/auto-confirm idempotency guard (mirror of dealers).
CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_orders_emp_delivery_draft
  ON employee_orders (employee_id, delivery_date)
  WHERE status = 'draft';
CREATE INDEX IF NOT EXISTS idx_employee_orders_emp_date
  ON employee_orders (employee_id, delivery_date);
CREATE INDEX IF NOT EXISTS idx_employee_orders_status
  ON employee_orders (status, delivery_date);


-- ── 4. employee_order_items ──────────────────────────────────────────
-- Carries subsidy_percent + mrp_reference snapshots so a later rule
-- change never rewrites a placed indent's line history.
CREATE TABLE IF NOT EXISTS employee_order_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_order_id  uuid NOT NULL REFERENCES employee_orders(id) ON DELETE CASCADE,
  product_id         uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  product_name       text NOT NULL,
  quantity           integer NOT NULL CHECK (quantity > 0),
  unit_price         numeric(14, 2) NOT NULL,
  gst_percent        numeric(5, 2)  NOT NULL DEFAULT 0,
  gst_amount         numeric(14, 2) NOT NULL DEFAULT 0,
  line_total         numeric(14, 2) NOT NULL,
  subsidy_percent    numeric(5, 2)  NOT NULL DEFAULT 0,
  mrp_reference      numeric(14, 2) NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_employee_order_items_order
  ON employee_order_items (employee_order_id);


-- ── 5. employee_ledger (APPEND-ONLY) — credit tracking ───────────────
-- Mirror of dealer_ledger. `type` reuses ledger_type ('credit'|'debit').
-- closing balance = opening_balance + Σ(credit) − Σ(debit) over
-- non-'Opening' rows (same maths as checkDealerCredit).
CREATE TABLE IF NOT EXISTS employee_ledger (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id     uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  type            ledger_type NOT NULL,
  amount          numeric(14, 2) NOT NULL,
  reference_id    uuid,
  reference_type  text,
  voucher_type    text,
  voucher_date    date NOT NULL DEFAULT now(),
  description     text,
  balance_after   numeric(14, 2),
  performed_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_employee_ledger_employee
  ON employee_ledger (employee_id, created_at DESC);


-- ── 6. updated_at triggers (set_updated_at() from 0001/0004) ─────────
DO $$ BEGIN
  CREATE TRIGGER trg_employee_standing_indents_updated_at
    BEFORE UPDATE ON employee_standing_indents
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_employee_orders_updated_at
    BEFORE UPDATE ON employee_orders
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- Done. After this:
--   • employees.credit_limit / opening_balance — finance-managed credit.
--   • employee_standing_indents — per-employee daily template.
--   • employee_orders / _items  — the materialized daily indent.
--   • employee_ledger           — append-only credit ledger.
-- Entirely separate from dealer orders/ledger/finance reporting.
-- ════════════════════════════════════════════════════════════════════
