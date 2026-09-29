-- ════════════════════════════════════════════════════════════════════
-- Haveri Milk Union — Opening stock becomes a pure carry-forward
-- 0063_fgs_carry_forward_opening.sql
--
-- BEFORE: the FGS operator typed Opening by hand every morning. Nothing tied
-- it to the previous day, and in practice nothing did: over the 15 days to
-- 2026-08-02, 800+ of 831 stock-log rows had an opening that did NOT equal the
-- previous entry's closing. The sheet never balanced, and Received was left at
-- 0 for most SKUs because the operator folded incoming stock into the typed
-- opening instead.
--
-- AFTER: Opening is derived, never entered —
--
--     opening(D)  = closing(previous entry)
--     closing(D)  = opening(D) + received(D) − committed(D) − wastage(D)
--
-- so every increase in stock has to be entered as RECEIVED, and every decrease
-- as wastage or a real order. Opening is read-only in the UI and ignored on
-- the API if a stale client still sends it.
--
-- Two supporting decisions baked into the functions below:
--
--   1. "committed" is keyed on orders.stock_deducted, NOT on
--      status IN ('dispatched','delivered'). stock_deducted is the reservation
--      latch the dealer app's availability already subtracts, so the FGS
--      closing and the dealer-facing "in stock" number are now the SAME
--      expression — they cannot drift apart again (the SAMRUDHI incident was
--      exactly that drift). Cancelled orders are excluded outright: 11,629
--      units across 499 order lines in the last 30 days are cancelled yet
--      still latched (a known cancel-path leak), and a cancelled order must
--      never hold stock.
--
--   2. Variant SKUs resolve to their stock-owning base via
--      COALESCE(stock_source_product_id, id) — see migration 0059. The old
--      per-date dispatched rollup did not, so subsidy-line quantities never
--      came off the base SKU's sheet.
--
-- CUTOVER. A strict carry-forward run against the historical data would be a
-- catastrophe: the highest-volume SKUs have stock-log gaps of 3–32 days, so
-- subtracting every un-recorded dispatch since their last entry puts them
-- deeply negative (SHUBHAM 500ML: −39,079) and the stock gate would refuse
-- every order for them. So this migration writes a BASELINE row for the
-- cutover day carrying each product's opening EXACTLY as the system reports it
-- today, flagged opening_manual. Availability on cutover day is therefore
-- unchanged; the carry-forward starts from tomorrow, on numbers the operator
-- already trusts.
--
-- opening_manual is also the re-baseline escape hatch: after a physical stock
-- count, INSERT/UPDATE that day's row with the counted opening and the flag
-- set, and the chain continues from there.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Baseline marker ──────────────────────────────────────────────
ALTER TABLE fgs_stock_log
  ADD COLUMN IF NOT EXISTS opening_manual boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN fgs_stock_log.opening_manual IS
  'True only for rows whose opening was set outside the daily carry-forward: the cutover baseline, or a later physical re-count applied by SQL. Every other row''s opening is derived as the previous entry''s closing.';

-- The carry-forward looks up "latest row strictly before D" per product on
-- every read. uq_fgs_stock_product_date already covers (product_id, date) and
-- serves that DISTINCT ON, but spell out the descending form so the planner
-- takes it for the backwards scan too.
CREATE INDEX IF NOT EXISTS idx_fgs_stock_product_date_desc
  ON fgs_stock_log (product_id, date DESC);

-- ── 2. fgs_day(date) — the whole daily model, all products, one pass ──
-- The single source of truth for opening/received/dispatched/wastage/closing.
-- Every reader (Stock Entry, Stock Reports, the dealer product list, the order
-- stock gate) goes through this so they cannot disagree.
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
  WITH baseline AS (
    -- Products whose opening for this date was set outside the chain. They
    -- need no history at all, which is what keeps the cutover day cheap: on
    -- that day EVERY product is a baseline, so `anchor` is empty and the
    -- orders scan below collapses to the single day.
    SELECT f.product_id, f.opening
      FROM fgs_stock_log f
     WHERE f.date = p_date AND f.opening_manual
  ),
  anchor AS (
    -- The most recent entry strictly before p_date. Because it is the LATEST
    -- such row, no other row sits between it and p_date — its own closing is
    -- what carries forward, and days with no entry at all contribute no
    -- received/wastage (only their committed orders, subtracted below).
    SELECT DISTINCT ON (f.product_id)
           f.product_id, f.date, f.opening, f.received, f.wastage
      FROM fgs_stock_log f
     WHERE f.date < p_date
       AND NOT EXISTS (SELECT 1 FROM baseline b WHERE b.product_id = f.product_id)
     ORDER BY f.product_id, f.date DESC
  ),
  committed AS (
    -- Stock spoken for by live orders, per delivery date. Same latch the
    -- dealer app subtracts; cancelled orders released even when the cancel
    -- path forgot to clear the latch; variant SKUs folded onto their base.
    SELECT COALESCE(pp.stock_source_product_id, pp.id) AS product_id,
           o.delivery_date                             AS d,
           SUM(oi.quantity)::int                       AS qty
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      JOIN products pp    ON pp.id = oi.product_id
     WHERE o.stock_deducted = true
       AND o.status <> 'cancelled'
       AND o.delivery_date >= COALESCE((SELECT MIN(a.date) FROM anchor a), p_date)
       AND o.delivery_date <= p_date
     GROUP BY 1, 2
  ),
  today_committed AS (
    SELECT c.product_id, c.qty FROM committed c WHERE c.d = p_date
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
  )
  SELECT p.id,
         -- A baseline row's typed opening wins; otherwise carry forward.
         COALESCE(b.opening, cr.opening, 0)::int                        AS opening,
         COALESCE(f.received, 0)::int                                   AS received,
         COALESCE(tc.qty, 0)::int                                       AS dispatched,
         COALESCE(f.wastage, 0)::int                                    AS wastage,
         (COALESCE(b.opening, cr.opening, 0)
          + COALESCE(f.received, 0)
          - COALESCE(tc.qty, 0)
          - COALESCE(f.wastage, 0))::int                                AS closing
    FROM products p
    LEFT JOIN baseline b         ON b.product_id = p.id
    LEFT JOIN carried cr         ON cr.product_id = p.id
    LEFT JOIN today_committed tc ON tc.product_id = p.id
    LEFT JOIN fgs_stock_log f    ON f.product_id  = p.id AND f.date = p_date
   WHERE p.deleted_at IS NULL
$$;

COMMENT ON FUNCTION fgs_day(date) IS
  'Daily FGS model for every live product on a date: opening carried from the previous entry''s closing, received/wastage as entered, dispatched = stock committed to live orders for that delivery date. Single source of truth for the Stock Entry sheet, stock reports, dealer availability and the order stock gate.';

-- ── 3. fgs_available(product, date) — the scalar the order gate uses ──
-- Identical arithmetic to fgs_day's `closing`, narrowed to one product so a
-- confirm does not scan every SKU. Pass the STOCK-owning product id (resolve
-- variants with COALESCE(stock_source_product_id, id) first). Returns the RAW,
-- possibly-negative figure: callers floor it for display, and read < 0 after
-- latching an order as oversell.
DROP FUNCTION IF EXISTS fgs_available(uuid, date);
CREATE FUNCTION fgs_available(p_product_id uuid, p_date date)
RETURNS integer
LANGUAGE sql
STABLE
AS $$
  WITH anchor AS (
    SELECT f.date, f.opening, f.received, f.wastage
      FROM fgs_stock_log f
     WHERE f.product_id = p_product_id
       AND f.date < p_date
     ORDER BY f.date DESC
     LIMIT 1
  ),
  today_row AS (
    SELECT f.opening, f.received, f.wastage, f.opening_manual
      FROM fgs_stock_log f
     WHERE f.product_id = p_product_id
       AND f.date = p_date
  ),
  committed AS (
    SELECT COALESCE(SUM(oi.quantity), 0)::int AS qty
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      JOIN products pp    ON pp.id = oi.product_id
     WHERE o.stock_deducted = true
       AND o.status <> 'cancelled'
       AND COALESCE(pp.stock_source_product_id, pp.id) = p_product_id
       -- From the anchor day (whose closing carries forward) through p_date.
       -- Everything committed in between has already left the balance.
       AND o.delivery_date >= COALESCE(
             CASE WHEN (SELECT t.opening_manual FROM today_row t) THEN p_date END,
             (SELECT a.date FROM anchor a),
             p_date)
       AND o.delivery_date <= p_date
  )
  SELECT (
      CASE
        WHEN (SELECT t.opening_manual FROM today_row t)
          THEN (SELECT t.opening FROM today_row t)
        ELSE COALESCE((SELECT a.opening + a.received - a.wastage FROM anchor a), 0)
      END
    + COALESCE((SELECT t.received FROM today_row t), 0)
    - COALESCE((SELECT t.wastage  FROM today_row t), 0)
    - (SELECT qty FROM committed)
  )::int
$$;

COMMENT ON FUNCTION fgs_available(uuid, date) IS
  'Day-aware available quantity for one stock-owning product — the same number fgs_day reports as that date''s closing, and the same number the dealer app shows. Raw (may be negative) so a caller can read < 0 as oversell.';

-- ── 4. Cutover baseline ─────────────────────────────────────────────
-- Freeze today's opening for EVERY live product at exactly the value the
-- current (pre-migration) formula reports, so nothing a dealer can see moves
-- on cutover day. From tomorrow the chain runs on its own.
--
-- Products that already have a row for today keep the opening the operator
-- typed — that is what the app is serving right now — and simply get flagged.
INSERT INTO fgs_stock_log (product_id, date, opening, received, dispatched, wastage, closing, entered_by, opening_manual)
SELECT p.id,
       (now() AT TIME ZONE 'Asia/Kolkata')::date,
       COALESCE(
         today.opening,
         (SELECT prev.closing
            FROM fgs_stock_log prev
           WHERE prev.product_id = p.id
             AND prev.date < (now() AT TIME ZONE 'Asia/Kolkata')::date
           ORDER BY prev.date DESC
           LIMIT 1),
         0
       )                                   AS opening,
       COALESCE(today.received, 0)         AS received,
       0                                   AS dispatched,  -- derived on read
       COALESCE(today.wastage, 0)          AS wastage,
       0                                   AS closing,     -- derived on read
       COALESCE(
         (SELECT f.entered_by FROM fgs_stock_log f ORDER BY f.created_at DESC LIMIT 1),
         (SELECT u.id FROM users u LIMIT 1)
       )                                   AS entered_by,
       true                                AS opening_manual
  FROM products p
  LEFT JOIN fgs_stock_log today
         ON today.product_id = p.id
        AND today.date = (now() AT TIME ZONE 'Asia/Kolkata')::date
 WHERE p.deleted_at IS NULL
   -- Subsidy-only SKU (migration 0056) draws stock from its base, never its own.
   AND p.code IS DISTINCT FROM 'PD0191S'
ON CONFLICT (product_id, date) DO UPDATE
  SET opening_manual = true;

-- dispatched/closing are derived on every read; keep the stored copies in step
-- so anyone querying fgs_stock_log directly sees the same numbers the app does.
UPDATE fgs_stock_log f
   SET dispatched = d.dispatched,
       closing    = d.closing,
       updated_at = now()
  FROM fgs_day((now() AT TIME ZONE 'Asia/Kolkata')::date) d
 WHERE f.product_id = d.product_id
   AND f.date = (now() AT TIME ZONE 'Asia/Kolkata')::date
   AND (f.dispatched, f.closing) IS DISTINCT FROM (d.dispatched, d.closing);

COMMIT;
