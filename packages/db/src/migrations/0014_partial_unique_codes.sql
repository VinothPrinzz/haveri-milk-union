-- Haveri Milk Union — Partial unique constraints on soft-deletable tables
-- Drops plain UNIQUE, replaces with partial unique WHERE deleted_at IS NULL.
-- Soft-deleted rows can now have their codes reused.

-- ── Routes ──
ALTER TABLE routes DROP CONSTRAINT IF EXISTS routes_code_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_routes_code_active
  ON routes (code) WHERE deleted_at IS NULL;

-- ── Batches ──
ALTER TABLE batches DROP CONSTRAINT IF EXISTS batches_batch_number_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_batches_batch_number_active
  ON batches (batch_number) WHERE deleted_at IS NULL;

-- ── Contractors (same pattern — prevents the same bug here) ──
-- Note: 0009 already created uq_contractors_code as partial. Leaving as-is.