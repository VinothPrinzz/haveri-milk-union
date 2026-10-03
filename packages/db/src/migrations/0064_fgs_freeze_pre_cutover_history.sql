-- ════════════════════════════════════════════════════════════════════
-- Haveri Milk Union — Freeze pre-cutover stock history
-- 0064_fgs_freeze_pre_cutover_history.sql
--
-- Migration 0063 made Opening a carry-forward and routed every reader through
-- fgs_day(). That was applied to ALL dates, including the past — so opening a
-- historical Stock Entry sheet re-derived it against order data it had never
-- been reconciled against. 2026-07-28 rendered a closing of −96,540 against a
-- recorded 44,725.
--
-- No stored row was ever modified (verified: no fgs_stock_log row before the
-- cutover has been written to since it was originally entered). This is purely
-- a read-path fix.
--
-- The July data comes from a period when only a few test routes were live,
-- while the order tables carry every route. Re-deriving one against the other
-- is meaningless, so those days must simply show what was recorded.
--
-- AFTER this migration:
--   • date <  cutover  → the EXACT pre-0063 display: stored opening (falling
--                        back to the previous entry's stored closing), stored
--                        received/wastage, dispatched summed from
--                        status IN ('dispatched','delivered') on the raw
--                        product id, closing recomputed from those. Byte-for-
--                        byte what the screen showed before 0063.
--   • date >= cutover  → the carry-forward model from 0063.
--
-- The cutover is discovered, not hardcoded: it is the first date carrying a
-- baseline row (opening_manual), i.e. the day the carry-forward era began. A
-- later re-baseline adds a LATER date, so MIN() stays put.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

DROP FUNCTION IF EXISTS fgs_day(date);
CREATE FUNCTION fgs_day(p_date date)
RETURNS TABLE (
  product_id uuid,
  opening    integer,
  received   integer,
  dispatched integer,
  wastage    integer,
  closing    integer
)
LANGUAGE sql
STABLE
AS $$
  WITH cutover AS (
    -- First day of the carry-forward era. No baseline anywhere (fresh DB) →
    -- treat every date as carry-forward.
    SELECT COALESCE(
             (SELECT MIN(f.date) FROM fgs_stock_log f WHERE f.opening_manual),
             '-infinity'::date
           ) AS d
  ),

  -- ══ LEGACY BRANCH — dates before the cutover ══
  -- Reproduces the pre-0063 read path exactly. Nothing here consults
  -- opening_manual or stock_deducted; history renders as it always did.
  legacy_dispatched AS (
    SELECT oi.product_id, SUM(oi.quantity)::int AS qty
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
     WHERE p_date < (SELECT d FROM cutover)
       AND o.delivery_date = p_date
       AND o.status IN ('dispatched', 'delivered')
     GROUP BY oi.product_id
  ),
  legacy AS (
    SELECT p.id AS product_id,
           COALESCE(
             f.opening,
             (SELECT prev.closing
                FROM fgs_stock_log prev
               WHERE prev.product_id = p.id
                 AND prev.date < p_date
               ORDER BY prev.date DESC
               LIMIT 1),
             0
           )::int                      AS opening,
           COALESCE(f.received, 0)::int AS received,
           COALESCE(ld.qty, 0)::int     AS dispatched,
           COALESCE(f.wastage, 0)::int  AS wastage
      FROM products p
      LEFT JOIN fgs_stock_log f      ON f.product_id  = p.id AND f.date = p_date
      LEFT JOIN legacy_dispatched ld ON ld.product_id = p.id
     WHERE p.deleted_at IS NULL
       AND p_date < (SELECT d FROM cutover)
  ),

  -- ══ CARRY-FORWARD BRANCH — the cutover day onward (migration 0063) ══
  baseline AS (
    SELECT f.product_id, f.opening
      FROM fgs_stock_log f
     WHERE p_date >= (SELECT d FROM cutover)
       AND f.date = p_date AND f.opening_manual
  ),
  anchor AS (
    SELECT DISTINCT ON (f.product_id)
           f.product_id, f.date, f.opening, f.received, f.wastage
      FROM fgs_stock_log f
     WHERE p_date >= (SELECT d FROM cutover)
       AND f.date < p_date
       -- Never reach back past the cutover: pre-cutover closings were computed
       -- under the old model and are not comparable.
       AND f.date >= (SELECT d FROM cutover)
       AND NOT EXISTS (SELECT 1 FROM baseline b WHERE b.product_id = f.product_id)
     ORDER BY f.product_id, f.date DESC
  ),
  committed AS (
    SELECT COALESCE(pp.stock_source_product_id, pp.id) AS product_id,
           o.delivery_date                             AS d,
           SUM(oi.quantity)::int                       AS qty
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      JOIN products pp    ON pp.id = oi.product_id
     WHERE p_date >= (SELECT d FROM cutover)
       AND o.stock_deducted = true
       AND o.status <> 'cancelled'
       AND o.delivery_date >= COALESCE((SELECT MIN(a.date) FROM anchor a), p_date)
       AND o.delivery_date <= p_date
     GROUP BY 1, 2
  ),
  carried AS (
    SELECT a.product_id,
           (a.opening + a.received - a.wastage
            - COALESCE((SELECT SUM(c.qty)
                          FROM committed c
                         WHERE c.product_id = a.product_id
                           AND c.d >= a.date
                           AND c.d <  p_date), 0))::int AS opening
      FROM anchor a
  ),
  current_era AS (
    SELECT p.id AS product_id,
           COALESCE(b.opening, cr.opening, 0)::int AS opening,
           COALESCE(f.received, 0)::int            AS received,
           COALESCE((SELECT SUM(c.qty)::int FROM committed c
                      WHERE c.product_id = p.id AND c.d = p_date), 0) AS dispatched,
           COALESCE(f.wastage, 0)::int             AS wastage
      FROM products p
      LEFT JOIN baseline b      ON b.product_id  = p.id
      LEFT JOIN carried cr      ON cr.product_id = p.id
      LEFT JOIN fgs_stock_log f ON f.product_id  = p.id AND f.date = p_date
     WHERE p.deleted_at IS NULL
       AND p_date >= (SELECT d FROM cutover)
  ),
  merged AS (
    SELECT * FROM legacy
    UNION ALL
    SELECT * FROM current_era
  )
  SELECT m.product_id, m.opening, m.received, m.dispatched, m.wastage,
         (m.opening + m.received - m.dispatched - m.wastage)::int AS closing
    FROM merged m
$$;

COMMENT ON FUNCTION fgs_day(date) IS
  'Daily FGS model for every live product on a date. From the cutover day (first opening_manual row) onward: opening carried from the previous entry''s closing, dispatched = stock committed to live orders. Before the cutover: the exact pre-migration-0063 display, so historical sheets keep showing what was recorded during the test-route period.';

COMMIT;
