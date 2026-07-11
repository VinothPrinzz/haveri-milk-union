-- ══════════════════════════════════════════════════════════════════
-- 0026_vip_employee_sales.sql
--
-- Adds two new direct-sale flows:
--   • VIP Free Sample        — grand_total = 0, payment_mode = 'complimentary'
--   • Employee Subsidy       — locked to products listed in employee_subsidy_rules
--
-- Changes:
--   1. Extend direct_sale_customer_type enum with 'vip_sample',
--      'employee_subsidy'
--   2. Extend payment_mode enum with 'complimentary'
--   3. Add direct_sales.recipient_name (snapshot)
--   4. New masters: vip_contacts, employees, employee_subsidy_rules
--   5. Seed one rule: HTM-1000ml @ 50% (only if that product exists)
-- ══════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Enums ─────────────────────────────────────────────────────────
DO $$ BEGIN
  ALTER TYPE direct_sale_customer_type ADD VALUE IF NOT EXISTS 'vip_sample';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TYPE direct_sale_customer_type ADD VALUE IF NOT EXISTS 'employee_subsidy';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TYPE payment_mode ADD VALUE IF NOT EXISTS 'complimentary';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 2. direct_sales.recipient_name ───────────────────────────────────
ALTER TABLE direct_sales
  ADD COLUMN IF NOT EXISTS recipient_name text;

COMMENT ON COLUMN direct_sales.recipient_name IS
  'Snapshot of recipient name at sale time. Used by VIP samples and employee subsidies; left NULL for agent/cash sales (resolved via dealers/cash_customers join).';

-- ── 3. vip_contacts ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vip_contacts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  phone       text,
  designation text,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
CREATE INDEX IF NOT EXISTS idx_vip_contacts_name
  ON vip_contacts (name) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_vip_contacts_phone
  ON vip_contacts (phone) WHERE deleted_at IS NULL AND phone IS NOT NULL;

-- ── 4. employees ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS employees (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_code  text,
  name           text NOT NULL,
  phone          text,
  department     text,
  designation    text,
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_employees_code
  ON employees (employee_code)
  WHERE deleted_at IS NULL AND employee_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_employees_name
  ON employees (name) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_employees_active
  ON employees (active) WHERE deleted_at IS NULL;

-- ── 5. employee_subsidy_rules ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS employee_subsidy_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id      uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  subsidy_percent numeric(5, 2) NOT NULL CHECK (subsidy_percent >= 0 AND subsidy_percent <= 100),
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
-- Only one active rule per product
CREATE UNIQUE INDEX IF NOT EXISTS uq_emp_subsidy_active_product
  ON employee_subsidy_rules (product_id) WHERE active = true;

-- ── 6. Seed HTM-1000ml rule (best-effort, idempotent) ────────────────
DO $$
DECLARE
  v_product_id uuid;
BEGIN
  SELECT id INTO v_product_id
  FROM products
  WHERE code = 'HTM-1000ml' AND deleted_at IS NULL
  LIMIT 1;

  IF v_product_id IS NULL THEN
    RAISE NOTICE 'employee_subsidy_rules seed: product code HTM-1000ml not found — skipping seed. Insert manually once the product exists.';
  ELSE
    INSERT INTO employee_subsidy_rules (product_id, subsidy_percent, active)
    VALUES (v_product_id, 50.00, true)
    ON CONFLICT DO NOTHING;
    RAISE NOTICE 'employee_subsidy_rules seed: HTM-1000ml rule inserted (or already present).';
  END IF;
END $$;

-- ── 7. updated_at triggers ───────────────────────────────────────────
-- Uses the existing set_updated_at() helper from 0001/0004.
DO $$ BEGIN
  CREATE TRIGGER trg_vip_contacts_updated_at
    BEFORE UPDATE ON vip_contacts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_employees_updated_at
    BEFORE UPDATE ON employees
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_emp_subsidy_rules_updated_at
    BEFORE UPDATE ON employee_subsidy_rules
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMIT;