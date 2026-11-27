-- ════════════════════════════════════════════════════════════════════
-- Haveri Milk Union — Order / gate pass modification log
-- 0085_order_modifications.sql
--
-- Why:
--   A modify rewrites orders.grand_total (or direct_sales.grand_total) in
--   place, so the dealer statement only ever showed the final amount: the
--   dealer could not see that an indent had been changed, by how much, or
--   when. The ledger movements a modify posts are (rightly) kept off the
--   statement, since the invoice line is already net of them.
--
-- What:
--   • order_modifications — one row per modify of a placed indent
--     (source 'order') or an agent gate pass (source 'gate_pass'): old and
--     new totals, the lines before and after, who and when. The statement
--     prints these as information rows that do not move the balance.
--
-- Backfill: modifies made before this migration left only their ledger
-- movement (description 'Modify …'). Those rows are copied in with the
-- change amount alone (old / new totals unknown), source_ref = the ledger
-- row, so a re-run does not copy them twice.
--
-- Idempotent.
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS order_modifications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source        text NOT NULL CHECK (source IN ('order', 'gate_pass')),
  -- orders.id or direct_sales.id (orders is partitioned, so no FK)
  order_id      uuid NOT NULL,
  dealer_id     uuid NOT NULL REFERENCES dealers(id) ON DELETE CASCADE,
  modified_at   timestamptz NOT NULL DEFAULT now(),
  modified_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  old_total     numeric(12, 2),
  new_total     numeric(12, 2),
  -- new − old; for backfilled rows, the ledger movement
  delta         numeric(12, 2) NOT NULL,
  -- [{ productId, name, qty }]
  old_items     jsonb,
  new_items     jsonb,
  -- Backfill only: the dealer_ledger row it was copied from
  source_ref    uuid UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_order_modifications_dealer
  ON order_modifications (dealer_id, modified_at);
CREATE INDEX IF NOT EXISTS idx_order_modifications_order
  ON order_modifications (order_id);

INSERT INTO order_modifications (source, order_id, dealer_id, modified_at, modified_by, delta, source_ref)
SELECT CASE WHEN dl.description ILIKE '%gate pass%' OR dl.description ILIKE 'Modify sale%'
            THEN 'gate_pass' ELSE 'order' END,
       dl.reference_id, dl.dealer_id, dl.created_at,
       (SELECT u.id FROM users u WHERE u.id = dl.performed_by),
       CASE WHEN dl.type = 'debit' THEN dl.amount ELSE -dl.amount END,
       dl.id
  FROM dealer_ledger dl
 WHERE dl.description ILIKE 'Modify %'
   AND dl.reference_id IS NOT NULL
   AND dl.amount <> 0
ON CONFLICT (source_ref) DO NOTHING;
