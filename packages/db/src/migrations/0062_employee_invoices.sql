-- ════════════════════════════════════════════════════════════════════
-- Haveri Milk Union — Invoices for employee indents
-- 0062_employee_invoices.sql
--
-- The employee subsidy SKU (today: GHEE SACHET 500ML @ 50%, the only
-- active employee_subsidy_rules row) was sold through direct_sales. That
-- table is read by neither All Indents (GET /orders) nor the Dispatch
-- Sheet (GET /dispatch-sheet), so the goods were invisible to the office
-- and to the loading staff, and no tax invoice was ever raised.
--
-- The fix promotes employee subsidy onto the employee_orders rail that
-- already exists (employee-indents.ts, materialize-drafts, auto-confirm)
-- and unions it into those two screens. This migration is the one piece
-- the code can't do on its own: an invoice must be able to belong to an
-- EMPLOYEE rather than a dealer.
--
-- Deliberately NOT done here: orders.dealer_id stays NOT NULL and keeps
-- its 72 `JOIN dealers` readers. Employee indents live in employee_orders;
-- only the invoice is made party-agnostic.
--
-- invoices.order_id has no FK (only uq_invoices_order_id), so it holds an
-- employee_orders.id as happily as an orders.id.
--
-- Apply MANUALLY on prod (the migration runner is off there — the
-- _migrations table is stale). Idempotent; safe to re-run.
-- ════════════════════════════════════════════════════════════════════

-- ── 1. The invoiced party becomes optional-per-side ──────────────────
ALTER TABLE invoices
  ALTER COLUMN dealer_id DROP NOT NULL;

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS employee_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'invoices_employee_id_fkey'
  ) THEN
    ALTER TABLE invoices
      ADD CONSTRAINT invoices_employee_id_fkey
      FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE RESTRICT;
  END IF;
END $$;

-- ── 2. Exactly one party, never zero and never both ──────────────────
-- dealer_name stays NOT NULL and carries the party name for both kinds,
-- so the PDF header and every existing report keep working unchanged.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'invoices_party_chk'
  ) THEN
    ALTER TABLE invoices
      ADD CONSTRAINT invoices_party_chk
      CHECK (num_nonnulls(dealer_id, employee_id) = 1);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_invoices_employee
  ON invoices (employee_id) WHERE employee_id IS NOT NULL;

-- ── 3. employee_orders needs the columns an indent carries ───────────
-- cancel_window_ends_at / notes mirror orders so the All Indents union can
-- select the same shape; delivery-window cancellation reuses the route's
-- time_windows row exactly as the dealer path does.
ALTER TABLE employee_orders
  ADD COLUMN IF NOT EXISTS notes text;

ALTER TABLE employee_orders
  ADD COLUMN IF NOT EXISTS cancel_window_ends_at timestamptz;

-- One live (non-cancelled) employee order per employee per delivery date.
-- employee_orders is NOT partitioned, so unlike `orders` this constraint is
-- actually enforceable in the DB — the subsidy placement appends to the
-- day's existing order rather than opening a second one.
CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_orders_emp_delivery_active
  ON employee_orders (employee_id, delivery_date)
  WHERE status <> 'cancelled';
