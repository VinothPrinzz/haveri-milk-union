-- ════════════════════════════════════════════════════════════════════
-- Haveri Milk Union — Milk Leakage Incentive
-- 0078_leakage_incentive.sql
--
-- Why:
--   The union pays every agent a leakage incentive on the milk they lift:
--
--     incentive litres = milk litres × 1.5 / 1000
--     incentive ₹      = incentive litres × rate per litre (₹44.65)
--
--   and settles it as a credit note on the agent's account. Finance used
--   to work this out in Excel taluk by taluk and key every credit note by
--   hand.
--
-- What:
--   • leakage_incentive_runs  — one row per posted period: the period, the
--     rule it was computed with (litres per 1000, rate, product codes) and
--     the totals. An EXCLUDE constraint stops two live (posted) runs from
--     covering the same day, so a period can never be credited twice;
--     reversing a run frees its period for a corrected re-run.
--   • leakage_incentive_lines — one row per agent in the run, with the
--     milk litres, incentive and the credit note it produced (ledger entry
--     + ledger_adjustments row). Agents whose amount rounds to ₹0.00 keep a
--     line for the record but get no credit note.
--   • system_settings (category 'finance') — the default rule shown on
--     Finance → Leakage Incentive: litres per 1000, rate per litre, and the
--     product codes that count as milk. "Milk" is an explicit SKU list, not
--     the Milk category, because that category also holds milk chocolates,
--     milk rusk, buffalo-milk paneer and other non-liquid lines.
--
-- Idempotent — IF NOT EXISTS + ON CONFLICT DO NOTHING.
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS leakage_incentive_runs (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_from            date NOT NULL,
  period_to              date NOT NULL,
  litres_per_1000        numeric(8, 3)  NOT NULL CHECK (litres_per_1000 > 0),
  rate_per_litre         numeric(10, 2) NOT NULL CHECK (rate_per_litre > 0),
  product_codes          text[] NOT NULL,
  voucher_date           date NOT NULL,

  dealer_count           int            NOT NULL DEFAULT 0,  -- agents credited (amount > 0)
  total_milk_litres      numeric(14, 3) NOT NULL DEFAULT 0,
  total_incentive_litres numeric(12, 3) NOT NULL DEFAULT 0,
  total_amount           numeric(12, 2) NOT NULL DEFAULT 0,

  status                 text NOT NULL DEFAULT 'posted'
                         CHECK (status IN ('posted', 'reversed')),
  created_by             uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at             timestamptz NOT NULL DEFAULT now(),
  reversed_by            uuid REFERENCES users(id) ON DELETE SET NULL,
  reversed_at            timestamptz,
  reverse_reason         text,

  CONSTRAINT leakage_runs_period_check CHECK (period_to >= period_from),
  -- No two posted runs may share a day. Range-only GiST, so no btree_gist.
  CONSTRAINT leakage_runs_no_overlap EXCLUDE USING gist (
    daterange(period_from, period_to, '[]') WITH &&
  ) WHERE (status = 'posted')
);

CREATE INDEX IF NOT EXISTS idx_leakage_runs_created
  ON leakage_incentive_runs (created_at DESC);


CREATE TABLE IF NOT EXISTS leakage_incentive_lines (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id            uuid NOT NULL REFERENCES leakage_incentive_runs(id) ON DELETE RESTRICT,
  dealer_id         uuid NOT NULL REFERENCES dealers(id) ON DELETE RESTRICT,
  taluka            text,                                   -- snapshot, for the record
  milk_litres       numeric(14, 3) NOT NULL,
  incentive_litres  numeric(12, 3) NOT NULL,
  amount            numeric(12, 2) NOT NULL,
  ledger_entry_id   uuid REFERENCES dealer_ledger(id) ON DELETE RESTRICT,
  adjustment_id     uuid REFERENCES ledger_adjustments(id) ON DELETE RESTRICT,
  UNIQUE (run_id, dealer_id)
);

CREATE INDEX IF NOT EXISTS idx_leakage_lines_dealer
  ON leakage_incentive_lines (dealer_id);


-- Default rule (editable from Finance → Leakage Incentive).
-- Product codes: every pouch-milk SKU (HTM / HCM / Shubham / Samrudhi /
-- Buffalo, all pack sizes incl. the 510 / 550 / 1050 ml offer packs). The
-- employee subsidy SKU (PD0191S) is left out — it is never sold to agents.
INSERT INTO system_settings (category, key, value) VALUES
  ('finance', 'leakage_incentive_litres_per_1000', '1.5'),
  ('finance', 'leakage_incentive_rate_per_litre',  '44.65'),
  ('finance', 'leakage_incentive_product_codes',
   '["PD0185","PD0186","PD0187","PD0188","PD0189","PD0190","PD0191","PD0192","PD0193","PD0194","PD0248","PD0249","PD0274","PD0275","PD0276","PD0277","PD0278","PD0279","PD0099"]')
ON CONFLICT (category, key) DO NOTHING;
