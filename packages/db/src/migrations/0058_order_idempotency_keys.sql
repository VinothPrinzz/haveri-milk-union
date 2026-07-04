-- ════════════════════════════════════════════════════════════════════
-- Haveri Milk Union — Idempotent order placement
-- 0058_order_idempotency_keys.sql
--
-- Why:
--   Dealers on flaky rural connections see "Order Failed — Network error"
--   when the connection is reset AFTER the POST /orders transaction
--   commits but BEFORE the response reaches the phone. The dealer then
--   taps "Pay" again and a duplicate order is created (or, where the
--   uq_orders_dealer_delivery_active index applies, they get a confusing
--   constraint error instead of their already-placed order).
--
--   The mobile app now sends a client-generated idempotency key with
--   POST /api/v1/orders. A retry carrying the same key returns the
--   already-created order instead of inserting a new one — which also
--   makes it safe for the client to auto-retry on pure network failure.
--
-- Why a separate table (not a column on orders):
--   orders is PARTITIONED BY RANGE (created_at), and Postgres requires
--   every unique index on a partitioned table to include the partition
--   key — so a unique (dealer_id, idempotency_key) cannot live on orders
--   itself. This side table carries the real uniqueness guarantee; the
--   PRIMARY KEY makes the "claim" insert race-safe: of two concurrent
--   identical submissions, exactly one wins and the loser's transaction
--   rolls back and replays the winner's order.
--
-- Retention:
--   Keys only need to outlive the retry window (minutes). Rows are tiny;
--   if the table ever matters, prune with:
--     DELETE FROM order_idempotency_keys WHERE created_at < now() - interval '7 days';
--
-- Idempotent — safe to re-run.
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS order_idempotency_keys (
  dealer_id       uuid NOT NULL REFERENCES dealers(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  -- No FK to orders: it's a partitioned table (same convention as
  -- order_items / cancellation_requests).
  order_id        uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dealer_id, idempotency_key)
);

COMMENT ON TABLE order_idempotency_keys IS
  'One row per client-supplied idempotency key on POST /api/v1/orders. '
  'A retry with a seen (dealer_id, key) returns the recorded order_id '
  'instead of creating a duplicate order.';

-- For age-based pruning.
CREATE INDEX IF NOT EXISTS idx_order_idem_created
  ON order_idempotency_keys (created_at);
