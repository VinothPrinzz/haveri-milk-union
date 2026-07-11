-- ══════════════════════════════════════════════════════════════════
-- Haveri Milk Union — Cheque Lifecycle Migration
-- 0041_cheques.sql
--
-- payments.mode = 'cheque' has existed since 0015 but with no
-- lifecycle. This adds the cheques sub-table tracking receipt →
-- deposit → clear / bounce / stop, plus an optional reversal-ledger
-- pointer for bounced cheques.
--
-- Append-friendly. Existing cheque payments are backfilled as
-- status='cleared' (pre-existing assumption).
-- ══════════════════════════════════════════════════════════════════

DO $$ BEGIN
  CREATE TYPE cheque_status AS ENUM (
    'received',    -- in hand, not yet deposited
    'deposited',   -- handed to the bank, awaiting clearance
    'cleared',     -- bank confirmed credit (terminal)
    'bounced',     -- returned by the bank (terminal until re-presented)
    'stopped',     -- dealer issued stop instruction (terminal)
    'cancelled'    -- finance void before deposit
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS cheques (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id        uuid NOT NULL UNIQUE
                    REFERENCES payments(id) ON DELETE RESTRICT,
  dealer_id         uuid NOT NULL
                    REFERENCES dealers(id) ON DELETE RESTRICT,

  -- ── Cheque facts (immutable after creation) ─────────────────────
  cheque_number     text           NOT NULL,
  cheque_date       date           NOT NULL,           -- date written on cheque
  bank_name         text           NOT NULL,           -- drawer's bank
  branch            text,
  amount            numeric(12, 2) NOT NULL CHECK (amount > 0),

  -- ── Lifecycle ───────────────────────────────────────────────────
  status            cheque_status  NOT NULL DEFAULT 'received',
  received_date     date           NOT NULL DEFAULT CURRENT_DATE,

  deposited_date    date,
  deposited_to_bank text,                                -- 'Axis Current', etc.
  deposit_slip_no   text,

  cleared_date      date,
  bounced_date      date,
  bounce_reason     text,                                -- 'insufficient funds', etc.
  bank_charges      numeric(10, 2) NOT NULL DEFAULT 0,   -- our bank's bounce fee

  -- ── Audit ───────────────────────────────────────────────────────
  received_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  deposited_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  marked_cleared_by uuid REFERENCES users(id) ON DELETE SET NULL,
  marked_bounced_by uuid REFERENCES users(id) ON DELETE SET NULL,

  notes             text,

  -- ── Reversal trail (bounce path) ────────────────────────────────
  -- When a cheque bounces, we insert a reversing dealer_ledger debit
  -- and store its id here. NULL while the cheque is alive or cleared.
  reversal_ledger_entry_id uuid
    REFERENCES dealer_ledger(id) ON DELETE SET NULL,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  -- Terminal-date sanity. Lifecycle state is enforced in app code.
  CONSTRAINT cheques_date_order CHECK (
    (deposited_date IS NULL OR deposited_date >= received_date)
    AND (cleared_date IS NULL OR cleared_date >= COALESCE(deposited_date, received_date))
    AND (bounced_date IS NULL OR bounced_date >= COALESCE(deposited_date, received_date))
  )
);

CREATE INDEX IF NOT EXISTS idx_cheques_status_received
  ON cheques (status, received_date DESC);
CREATE INDEX IF NOT EXISTS idx_cheques_dealer
  ON cheques (dealer_id, received_date DESC);
CREATE INDEX IF NOT EXISTS idx_cheques_pending
  ON cheques (received_date)
  WHERE status IN ('received', 'deposited');
CREATE INDEX IF NOT EXISTS idx_cheques_number
  ON cheques (cheque_number);

DO $$ BEGIN
  CREATE TRIGGER trg_cheques_updated_at
    BEFORE UPDATE ON cheques
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Backfill — every historical cheque payment gets a stub row.
-- We don't have the bank name, so we use a placeholder; finance
-- can correct retroactively. Status='cleared' preserves the
-- previous assumption that all recorded cheques had cleared.
INSERT INTO cheques (
  payment_id, dealer_id, cheque_number, cheque_date,
  bank_name, amount, status, received_date, cleared_date, received_by
)
SELECT
  p.id, p.dealer_id,
  COALESCE(NULLIF(p.reference, ''), '—'),   -- reference held the number
  p.received_date,
  '— legacy —',
  p.amount,
  'cleared'::cheque_status,
  p.received_date,
  p.received_date,
  p.received_by
FROM payments p
LEFT JOIN cheques c ON c.payment_id = p.id
WHERE p.mode = 'cheque' AND c.id IS NULL;
