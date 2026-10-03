-- ════════════════════════════════════════════════════════════════════
-- Haveri Milk Union — every rail that moves stock now comes off the sheet
-- 0072_fgs_count_all_outflow_rails.sql
--
-- THE BUG. fgs_day()'s `committed` CTE has only ever read the `orders` table.
-- Two other rails also take goods off the FGS floor, and both were invisible
-- to the model, so the sheet kept showing stock that had left the building:
--
--   • direct_sales   — counter sales, VIP samples, agent gate passes
--   • employee_orders — the employee subsidy indent rail (its own table, NOT
--                       a partition of `orders`, so nothing about it was ever
--                       reachable from the orders join)
--
-- Caught in the field on 2026-08-06: KHARABOONDI 180GM (PD0205) read 3
-- available all day, while GP-0029 had walked 5 units out of the gate that
-- morning as a vip_sample. Availability was patched by hand that day; this
-- migration removes the need to ever do that again.
--
-- THE FIX. Both rails join orders as sibling outflow streams feeding the SAME
-- `committed` aggregation. That is the whole change — and note what does NOT
-- need changing because of it:
--
--   • Deduction needs no application code. `committed` is DERIVED from the
--     rows, so the moment a direct sale is inserted it is off the sheet.
--   • Cancellation needs no application code. Migration 0071 gave direct_sales
--     a status; filtering status = 'confirmed' releases a cancelled sale's
--     stock automatically, exactly as `o.status <> 'cancelled'` does for orders.
--   • Gate-pass returns need no application code. Netting off
--     gate_pass_items.returned_quantity puts returned units straight back.
--
-- Three modelling decisions, spelled out because they are easy to get wrong:
--
--   1. DATE = sale_date, not dispatched_at. A counter sale hands the goods over
--      then and there; the sale row IS the outflow event. This mirrors how an
--      order reserves at confirm (stock_deducted) rather than at dispatch, so
--      both streams commit stock at the moment it is spoken for.
--
--   2. QUANTITY = direct_sale_items.quantity − gate_pass_items.returned_quantity.
--      A gate pass issues N to an agent and takes R back unsold. Only the net
--      left the building. direct_sale_items.quantity is NOT reduced on return
--      (the returns endpoint only touches gate_pass_items), so the join is
--      required — reading direct_sale_items alone would permanently over-deduct
--      every return. LEFT JOIN because non-agent sales have no gate-pass row.
--
--   3. Variant SKUs resolve to their stock-owning base via
--      COALESCE(stock_source_product_id, id), same as orders (migration 0059).
--      This one matters most on the employee rail, whose subsidy SKUs are
--      exactly the variants migration 0059 was written for.
--
--   4. EMPLOYEE ORDERS COMMIT ON status NOT IN ('draft','cancelled'), because
--      employee_orders has NO stock_deducted column to latch. That is the
--      faithful analogue of the orders rule: a dealer order latches the moment
--      it stops being a draft (including 'payment_required' — see
--      lib/stock-check.ts) and releases on cancel. A draft employee indent is
--      still being edited and must hold nothing.
--
-- THE PRE-CUTOVER ERA IS UNTOUCHED. The legacy branch from migration 0064
-- still renders dates before the cutover exactly as recorded — direct sales are
-- added ONLY to the carry-forward branch. Verified before writing this: just 22
-- direct-sale units exist on or after the 2026-08-02 cutover (all on 08-06),
-- and no product's availability goes negative today as a result. The 155 units
-- sold before the cutover stay where they are, in frozen history. The employee
-- rail adds 4 more post-cutover units (2 lines of GHEE SACHET 500ML); its 44
-- draft units all predate the cutover and would not have counted regardless.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. fgs_day(date) — orders + direct sales ─────────────────────────
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
    SELECT COALESCE(
             (SELECT MIN(f.date) FROM fgs_stock_log f WHERE f.opening_manual),
             '-infinity'::date
           ) AS d
  ),

  -- ══ LEGACY BRANCH — dates before the cutover (migration 0064) ══
  -- Frozen. Direct sales are deliberately NOT added here: these days come from
  -- the test-route period and must keep showing what was recorded.
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

  -- ══ CARRY-FORWARD BRANCH — the cutover day onward ══
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
       AND f.date >= (SELECT d FROM cutover)
       AND NOT EXISTS (SELECT 1 FROM baseline b WHERE b.product_id = f.product_id)
     ORDER BY f.product_id, f.date DESC
  ),
  -- The window every outflow stream is measured over: from the anchor day
  -- (whose closing carries forward) through p_date.
  window_start AS (
    SELECT COALESCE((SELECT MIN(a.date) FROM anchor a), p_date) AS d
  ),

  -- ── Outflow stream 1: dealer/admin orders ──
  order_outflow AS (
    SELECT COALESCE(pp.stock_source_product_id, pp.id) AS product_id,
           o.delivery_date                             AS d,
           SUM(oi.quantity)::int                       AS qty
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      JOIN products pp    ON pp.id = oi.product_id
     WHERE p_date >= (SELECT d FROM cutover)
       AND o.stock_deducted = true
       AND o.status <> 'cancelled'
       AND o.delivery_date >= (SELECT d FROM window_start)
       AND o.delivery_date <= p_date
     GROUP BY 1, 2
  ),

  -- ── Outflow stream 2: direct sales (NEW) ──
  -- Counter sales, VIP samples and agent gate passes, net of gate-pass returns.
  --
  -- Both sides are pre-aggregated to one row per (sale, product) before they
  -- meet. Neither direct_sale_items nor gate_pass_items has a unique constraint
  -- on that pair — only plain indexes — so joining them raw would fan out the
  -- moment a sale ever carried two lines for the same product, subtracting the
  -- returned quantity once per line. That would silently under-count stock,
  -- which is the whole failure mode this migration exists to end.
  ds_lines AS (
    SELECT di.direct_sale_id, di.product_id, SUM(di.quantity)::int AS qty
      FROM direct_sale_items di
     GROUP BY 1, 2
  ),
  ds_returns AS (
    SELECT gpi.direct_sale_id, gpi.product_id,
           SUM(gpi.returned_quantity)::int AS qty
      FROM gate_pass_items gpi
     GROUP BY 1, 2
  ),
  direct_outflow AS (
    SELECT COALESCE(pp.stock_source_product_id, pp.id) AS product_id,
           ds.sale_date                                AS d,
           SUM(l.qty - COALESCE(r.qty, 0))::int        AS qty
      FROM direct_sales ds
      JOIN ds_lines l  ON l.direct_sale_id = ds.id
      JOIN products pp ON pp.id = l.product_id
      LEFT JOIN ds_returns r
             ON r.direct_sale_id = ds.id
            AND r.product_id     = l.product_id
     WHERE p_date >= (SELECT d FROM cutover)
       AND ds.status = 'confirmed'
       AND ds.sale_date >= (SELECT d FROM window_start)
       AND ds.sale_date <= p_date
     GROUP BY 1, 2
  ),

  -- ── Outflow stream 3: employee subsidy indents (NEW) ──
  -- employee_orders is its own table, not a partition of `orders`, so the
  -- orders join above can never see it. No stock_deducted column exists here;
  -- leaving draft is what commits the stock (see note 4 in the header).
  employee_outflow AS (
    SELECT COALESCE(pp.stock_source_product_id, pp.id) AS product_id,
           eo.delivery_date                            AS d,
           SUM(ei.quantity)::int                       AS qty
      FROM employee_orders eo
      JOIN employee_order_items ei ON ei.employee_order_id = eo.id
      JOIN products pp             ON pp.id = ei.product_id
     WHERE p_date >= (SELECT d FROM cutover)
       AND eo.status NOT IN ('draft', 'cancelled')
       AND eo.delivery_date >= (SELECT d FROM window_start)
       AND eo.delivery_date <= p_date
     GROUP BY 1, 2
  ),

  committed AS (
    SELECT o.product_id, o.d, SUM(o.qty)::int AS qty
      FROM (SELECT * FROM order_outflow
            UNION ALL
            SELECT * FROM direct_outflow
            UNION ALL
            SELECT * FROM employee_outflow) o
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
  'Daily FGS model for every live product on a date. From the cutover day (first opening_manual row) onward: opening carried from the previous entry''s closing, dispatched = stock committed across all three outflow rails — live dealer orders, confirmed direct sales (counter/sample/gate pass, net of gate-pass returns), and non-draft employee subsidy indents. Before the cutover: the exact pre-migration-0063 display, orders only.';

-- ── 2. fgs_available(product, date) — the scalar the order gate uses ──
-- Same arithmetic narrowed to one product, so a confirm does not scan every
-- SKU. Must stay in lockstep with fgs_day's closing or the gate and the sheet
-- drift apart — which is the failure 0063 was written to end.
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
  -- A manual re-baseline discards history: only p_date's own outflow counts
  -- against a counted opening. Otherwise measure from the anchor day.
  window_start AS (
    SELECT COALESCE(
             CASE WHEN (SELECT t.opening_manual FROM today_row t) THEN p_date END,
             (SELECT a.date FROM anchor a),
             p_date
           ) AS d
  ),
  order_outflow AS (
    SELECT COALESCE(SUM(oi.quantity), 0)::int AS qty
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      JOIN products pp    ON pp.id = oi.product_id
     WHERE o.stock_deducted = true
       AND o.status <> 'cancelled'
       AND COALESCE(pp.stock_source_product_id, pp.id) = p_product_id
       AND o.delivery_date >= (SELECT d FROM window_start)
       AND o.delivery_date <= p_date
  ),
  -- Pre-aggregated per (sale, product) for the same fan-out reason as fgs_day —
  -- see the note there. These two must stay identical in meaning.
  ds_lines AS (
    SELECT di.direct_sale_id, di.product_id, SUM(di.quantity)::int AS qty
      FROM direct_sale_items di
     GROUP BY 1, 2
  ),
  ds_returns AS (
    SELECT gpi.direct_sale_id, gpi.product_id,
           SUM(gpi.returned_quantity)::int AS qty
      FROM gate_pass_items gpi
     GROUP BY 1, 2
  ),
  direct_outflow AS (
    SELECT COALESCE(SUM(l.qty - COALESCE(r.qty, 0)), 0)::int AS qty
      FROM direct_sales ds
      JOIN ds_lines l  ON l.direct_sale_id = ds.id
      JOIN products pp ON pp.id = l.product_id
      LEFT JOIN ds_returns r
             ON r.direct_sale_id = ds.id
            AND r.product_id     = l.product_id
     WHERE ds.status = 'confirmed'
       AND COALESCE(pp.stock_source_product_id, pp.id) = p_product_id
       AND ds.sale_date >= (SELECT d FROM window_start)
       AND ds.sale_date <= p_date
  ),
  employee_outflow AS (
    SELECT COALESCE(SUM(ei.quantity), 0)::int AS qty
      FROM employee_orders eo
      JOIN employee_order_items ei ON ei.employee_order_id = eo.id
      JOIN products pp             ON pp.id = ei.product_id
     WHERE eo.status NOT IN ('draft', 'cancelled')
       AND COALESCE(pp.stock_source_product_id, pp.id) = p_product_id
       AND eo.delivery_date >= (SELECT d FROM window_start)
       AND eo.delivery_date <= p_date
  )
  SELECT (
      CASE
        WHEN (SELECT t.opening_manual FROM today_row t)
          THEN (SELECT t.opening FROM today_row t)
        ELSE COALESCE((SELECT a.opening + a.received - a.wastage FROM anchor a), 0)
      END
    + COALESCE((SELECT t.received FROM today_row t), 0)
    - COALESCE((SELECT t.wastage  FROM today_row t), 0)
    - (SELECT qty FROM order_outflow)
    - (SELECT qty FROM direct_outflow)
    - (SELECT qty FROM employee_outflow)
  )::int
$$;

COMMENT ON FUNCTION fgs_available(uuid, date) IS
  'Day-aware available quantity for one stock-owning product — the same number fgs_day reports as that date''s closing, and the same number the dealer app shows. Counts all three outflow rails: live orders, confirmed direct sales, and non-draft employee subsidy indents. Raw (may be negative) so a caller can read < 0 as oversell.';

-- ── 3. Undo the 2026-08-06 hand patch on PD0205 ──────────────────────
-- KHARABOONDI 180GM's opening was re-baselined by hand that day to absorb
-- GP-0029's 5 sample units, because the model could not see them. The model
-- can see them now, so leaving the patch in place would subtract them twice.
--
-- THE RULE THIS RESTORES: a stock correction belongs in DISPATCHED, never in
-- OPENING. Opening is not a free-standing figure — it is the carry-forward LINK
-- to the previous day's closing, so editing it to absorb an outflow silently
-- rewrites the chain and hides what actually left the building. Dispatched is
-- where goods leaving is supposed to show up, and after this migration it does:
-- PD0205 on 2026-08-06 reads opening=6, dispatched=6 (1 ordered + 5 sampled),
-- closing=0 — the same zero, now derived and visible instead of typed in.
--
-- So this is the ONLY statement in the migration that writes `opening`, and it
-- writes it exactly ONCE, to put back the 6 the row held before yesterday's
-- hand patch lowered it to 3. Net change to opening across both days: zero.
-- Step 4 below touches dispatched and closing only. The opening_manual hatch
-- from migration 0063 survives for what it was meant for — a genuine physical
-- re-count — and is not used here.
--
-- Scoped to exactly that product and date. The 2026-08-02 cutover baselines are
-- untouched — clearing one of those would move the discovered cutover and
-- unfreeze pre-cutover history.
--
-- Two statements, and the order matters. The stored `opening` column is not
-- decoration: the NEXT day's anchor reads it to carry forward. It must end up
-- holding the value the chain derives, so the flag is cleared FIRST (which is
-- what lets fgs_day derive an opening for the row at all), and only then is the
-- derived figure read back into the column. Restoring it from the previous
-- row's stored `closing` instead would import that column's staleness — 08-03
-- still stores the closing it was written with, before its own orders were
-- committed against it.
UPDATE fgs_stock_log f
   SET opening_manual = false, updated_at = now()
  FROM products p
 WHERE p.id = f.product_id
   AND p.code = 'PD0205'
   AND f.date = DATE '2026-08-06'
   AND f.opening_manual;

UPDATE fgs_stock_log f
   SET opening = d.opening, updated_at = now()
  FROM products p, fgs_day(DATE '2026-08-06') d
 WHERE p.id = f.product_id
   AND d.product_id = f.product_id
   AND p.code = 'PD0205'
   AND f.date = DATE '2026-08-06'
   AND f.opening IS DISTINCT FROM d.opening;

-- ── 4. Re-sync the stored dispatched/closing copies ──────────────────
-- Both are derived on read, but the columns are kept in step so anyone
-- querying fgs_stock_log directly sees what the app shows. Every post-cutover
-- day is re-synced because the direct-sale outflow may have moved any of them.
UPDATE fgs_stock_log f
   SET dispatched = d.dispatched,
       closing    = d.closing,
       updated_at = now()
  FROM (
    SELECT s.date, fd.product_id, fd.dispatched, fd.closing
      FROM (SELECT DISTINCT date FROM fgs_stock_log
             WHERE date >= (SELECT MIN(date) FROM fgs_stock_log WHERE opening_manual)) s
      CROSS JOIN LATERAL fgs_day(s.date) fd
  ) d
 WHERE f.product_id = d.product_id
   AND f.date       = d.date
   AND (f.dispatched, f.closing) IS DISTINCT FROM (d.dispatched, d.closing);

COMMIT;
