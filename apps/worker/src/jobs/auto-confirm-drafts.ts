// ═══════════════════════════════════════════════════════════════════════
// apps/worker/src/jobs/auto-confirm-drafts.ts
//
// Runs every 5 minutes. For each route that has reached the WARNING
// point of its ordering window (close_time − warning_minutes), AUTO-PLACE
// today's indent for every active dealer on that route — driven by the
// dealer's standing indent, not by whether a draft row happens to exist
// yet. It keeps re-checking each tick through ~15 min past close.
//
// An order the dealer started paying online for (payment_required +
// payment_mode='upi') is NEVER placed on credit; if it's still unpaid
// once close_time has passed, it is discarded (cancelled). The dealer
// had until window close to complete payment.
//
// WHY THIS IS STANDING-INDENT-DRIVEN (and not "confirm existing drafts"):
//   The old version only confirmed orders that were already
//   status='draft'. Those rows only exist if the nightly
//   materialize-drafts job ran the night before OR the dealer opened
//   the app and edited. A dealer who has a standing indent but never
//   opens the app (and whose draft wasn't pre-materialized) had NO row,
//   so nothing got placed for them at close time. GET /drafts/:date
//   only *synthesizes* a preview — it never persists. So this job now
//   materialises-then-confirms when a row is missing.
//
// Per dealer, for today's delivery_date:
//   • Most-recent order is 'draft'            → stock+credit-check → confirm / payment_required
//   • payment_required + 'upi' & past close   → discard (online pay never completed)
//   • Most-recent order is already placed     → skip (confirmed/dispatched/…)
//   • Most-recent order is 'cancelled'        → skip (respect the cancellation)
//   • No order at all + active standing       → materialise from standing → confirm
//   • No order + no standing indent           → skip (nothing to place)
//   • Dealer paused for today                 → skip
//
// Confirm logic mirrors POST /drafts/:date/confirm in dealer-indents.ts
// EXACTLY, including the dealer_ledger debit — so an auto-placed order
// is identical to a manually-placed one (hits the books, gets an
// invoice, counts toward outstanding).
//
// Notes:
//   • The credit check is duplicated from apps/api/src/lib/credit-check.ts
//     because the worker is its own package. Keep the two in sync.
//   • The lookback that decides "window just closed" is generous (15 min,
//     lower-bound inclusive) so a close_time landing exactly on the 5-min
//     cron boundary is never skipped. Re-processing is safe: every write
//     is guarded on status='draft' / "no order exists", so a route seen
//     on three consecutive ticks confirms each dealer at most once.
// ═══════════════════════════════════════════════════════════════════════

import { Job } from "bullmq";
import { sql } from "../lib/db.js";
import { pushQueue as notifQueue, pdfQueue } from "../lib/queues.js";

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

function istNow(): Date {
  return new Date(Date.now() + IST_OFFSET_MS);
}
function istTodayIso(): string {
  return istNow().toISOString().slice(0, 10);
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ── Credit check (in-worker copy of apps/api/src/lib/credit-check.ts) ─
// Ledger-based, IDENTICAL maths to checkDealerCredit() so an auto-confirm
// and a manual confirm agree on whether a dealer can afford an order.
// Prepaid balance model — no credit limit:
//   closing   = opening_balance + Σ(credit) − Σ(debit)   [non-'Opening' rows]
//   available = max(0, closing)
async function workerCreditCheck(
  dealerId: string,
  orderTotal: number
): Promise<{ available: number; sufficient: boolean; shortfall: number }> {
  const [row] = await sql`
    SELECT
      COALESCE(d.credit_limit, 0)::numeric AS credit_limit,
      (
        COALESCE(d.opening_balance, 0)
        + COALESCE((
            SELECT SUM(CASE WHEN dl.type = 'credit' THEN dl.amount
                            WHEN dl.type = 'debit'  THEN -dl.amount END)
              FROM dealer_ledger dl
             WHERE dl.dealer_id = d.id
               AND COALESCE(dl.voucher_type, '') <> 'Opening'
          ), 0)
      )::numeric AS closing_balance
    FROM dealers d
    WHERE d.id = ${dealerId}::uuid
      AND d.deleted_at IS NULL
  `;
  if (!row) throw new Error(`Dealer ${dealerId} not found`);
  const closing = parseFloat(row.closing_balance);
  const available = Math.max(0, closing);   // prepaid: balance only, no limit
  const sufficient = orderTotal <= available;
  const shortfall = sufficient ? 0 : round2(orderTotal - available);
  return { available: round2(available), sufficient, shortfall };
}

// ── Stock check / deduction (in-worker copy of apps/api/src/lib/stock-check.ts) ─
interface WorkerStockShortfall {
  productName: string;
  ordered: number;
  available: number;
}

/** Pure read — order lines whose quantity exceeds current product stock. */
async function workerStockShortfalls(
  orderId: string
): Promise<WorkerStockShortfall[]> {
  const rows = await sql`
    SELECT oi.product_name AS product_name,
           oi.quantity     AS ordered,
           p.stock         AS available
      FROM order_items oi
      JOIN products p ON p.id = oi.product_id
     WHERE oi.order_id = ${orderId}::uuid
       AND oi.quantity > p.stock
  `;
  return rows.map((r: any) => ({
    productName: r.product_name,
    ordered: Number(r.ordered),
    available: Number(r.available),
  }));
}

// Order-level Milk minimum (mirror of apps/api/src/lib/min-order-qty.ts —
// kept in sync because the worker is its own package). Within one order the
// TOTAL milk must reach 12 L; it applies only when milk is present. Curd has
// no minimum. Pack sizes normalise to L (ml→L).
const WORKER_CATEGORY_MIN = { milk: 12 } as const;

// Measure-matched: only volume-measured milk counts toward the litre minimum
// (the Milk category also holds gram-measured chocolates).
const WORKER_SIZE_TOKEN = /(\d+(?:\.\d+)?)\s*(kg|kilogram|ltr|litre|liter|ml|gm|g|l)\b/i;
function workerParseMeasure(text: string): { litres: number; kg: number } | null {
  const m = text.match(WORKER_SIZE_TOKEN);
  if (!m) return null;
  const size = parseFloat(m[1]!);
  switch (m[2]!.toLowerCase()) {
    case "ml":                                        return { litres: size / 1000, kg: 0 };
    case "l": case "ltr": case "litre": case "liter": return { litres: size, kg: 0 };
    case "g": case "gm":                              return { litres: 0, kg: size / 1000 };
    case "kg": case "kilogram":                       return { litres: 0, kg: size };
  }
  return null;
}
function workerUnitMeasure(unit: string | null, packSize: string | number | null, name: string | null): { litres: number; kg: number } {
  const fromUnit = workerParseMeasure((unit ?? "").toString());
  if (fromUnit) return fromUnit;
  const fromName = workerParseMeasure((name ?? "").toString());
  if (fromName) return fromName;
  const ps = typeof packSize === "string" ? parseFloat(packSize) : packSize ?? 0;
  if (ps && ps > 0) {
    const u = (unit ?? "").toString();
    if (/kg/i.test(u)) return { litres: 0, kg: ps };
    if (/ltr|litre|liter/i.test(u)) return { litres: ps, kg: 0 };
  }
  return { litres: 0, kg: 0 };
}

interface WorkerCategoryShortfall { category: "milk"; total: number; min: number; unit: string; }

/** Milk category in this order whose L total is below the minimum. */
async function workerCategoryMinShortfalls(orderId: string): Promise<WorkerCategoryShortfall[]> {
  // The subsidy HTM 1000ML SKU (code PD0191S, migration 0056) is EXEMPT from
  // the milk minimum — it's a half-price scheme line, so a subsidy-milk-only
  // standing indent still auto-confirms. Mirror of MIN_QTY_EXEMPT_CODES in
  // apps/api/src/lib/min-order-qty.ts (the worker is its own package).
  const rows = await sql`
    SELECT c.name AS category, oi.quantity AS quantity,
           p.unit AS unit, p.pack_size AS pack_size, p.name AS name
      FROM order_items oi
      JOIN products p   ON p.id = oi.product_id
      JOIN categories c ON c.id = p.category_id
     WHERE oi.order_id = ${orderId}::uuid
       AND oi.quantity > 0
       AND lower(c.name) = 'milk'
       AND COALESCE(p.code, '') <> 'PD0191S'
  `;
  let milkLitres = 0;
  for (const r of rows as any[]) {
    const cat = String(r.category).trim().toLowerCase();
    const m = workerUnitMeasure(r.unit, r.pack_size, r.name);
    if (cat === "milk") milkLitres += Number(r.quantity) * m.litres;
  }
  const out: WorkerCategoryShortfall[] = [];
  const milk = Math.round(milkLitres * 1000) / 1000;
  if (milk > 0 && milk < WORKER_CATEGORY_MIN.milk) {
    out.push({ category: "milk", total: milk, min: WORKER_CATEGORY_MIN.milk, unit: "L" });
  }
  return out;
}

// Thrown when a line can't be satisfied during the guarded deduction
// (a concurrent confirm drained stock). Rolls the confirm transaction back.
class WorkerStockConflict extends Error {
  constructor() {
    super("Insufficient stock");
    this.name = "WorkerStockConflict";
  }
}

/** Guarded, idempotent deduction inside the confirm tx — stock can never
 *  go negative. Claims the orders.stock_deducted latch first (mirror of
 *  apps/api/src/lib/stock-check.ts) so a re-run never double-deducts. */
async function deductOrderStockWorker(
  tx: typeof sql,
  orderId: string
): Promise<void> {
  const claimed = await tx`
    UPDATE orders SET stock_deducted = true, updated_at = now()
     WHERE id = ${orderId}::uuid AND stock_deducted = false
    RETURNING id
  `;
  if (claimed.count === 0) return; // already deducted
  const items = await tx`
    SELECT product_id::text AS product_id, quantity AS quantity
      FROM order_items WHERE order_id = ${orderId}::uuid
  `;
  for (const it of items as any[]) {
    const updated = await tx`
      UPDATE products
         SET stock = stock - ${it.quantity}, updated_at = now()
       WHERE id = ${it.product_id}::uuid
         AND stock >= ${it.quantity}
      RETURNING id
    `;
    if (updated.count === 0) throw new WorkerStockConflict();
  }
}

// ── Employee credit check (ledger-based; mirror of checkEmployeeCredit) ─
async function workerEmployeeCreditCheck(
  employeeId: string,
  orderTotal: number
): Promise<{ available: number; sufficient: boolean; shortfall: number }> {
  const [row] = await sql`
    SELECT
      COALESCE(e.credit_limit, 0)::numeric AS credit_limit,
      (
        COALESCE(e.opening_balance, 0)
        + COALESCE((
            SELECT SUM(CASE WHEN el.type = 'credit' THEN el.amount
                            WHEN el.type = 'debit'  THEN -el.amount END)
              FROM employee_ledger el
             WHERE el.employee_id = e.id
               AND COALESCE(el.voucher_type, '') <> 'Opening'
          ), 0)
      )::numeric AS closing_balance
    FROM employees e
    WHERE e.id = ${employeeId}::uuid AND e.deleted_at IS NULL
  `;
  if (!row) throw new Error(`Employee ${employeeId} not found`);
  const creditLimit = parseFloat(row.credit_limit);
  const closing = parseFloat(row.closing_balance);
  const available = Math.max(0, creditLimit + closing);
  const sufficient = orderTotal <= available;
  const shortfall = sufficient ? 0 : round2(orderTotal - available);
  return { available: round2(available), sufficient, shortfall };
}

// ── Types ────────────────────────────────────────────────────────────

interface RouteRow {
  id: string;
  name: string;
  close_time: string; // "HH:MM:SS"
  window_closed: boolean; // now() is at/after close_time (vs. only warning)
}

interface DealerRow {
  dealer_id: string;
  zone_id: string;
  dealer_name: string;
  fcm_token: string | null;
  notifications_enabled: boolean;
  order_id: string | null;
  order_status: string | null;
  payment_mode: string | null; // 'credit' | 'upi' | … — 'upi' = online-pay intent
  grand_total: string | null; // numeric → string
  item_count: number | null;
  paused: boolean;
  has_standing: boolean;
}

interface StandingItem {
  product_id: string;
  default_qty: number;
  name: string;
  base_price: string;
  gst_percent: string;
}

// ── Main job ─────────────────────────────────────────────────────────

export async function processAutoConfirmDrafts(_job: Job) {
  const todayIso = istTodayIso();
  const nowIstTime = istNow().toISOString().slice(11, 19); // "HH:MM:SS"

  // Routes that have reached the WARNING point of their window
  // (close_time − warning_minutes) and up to ~15 min past close.
  // Standing-indent auto-confirm fires from the warning time so today's
  // indents are locked in at the warning point — not only at close.
  // Re-processing on each 5-min tick through close+15 is safe: every
  // write is status-guarded, so a dealer confirms at most once.
  //   • window_closed = false → warning reached, window still open:
  //     confirm standing-indent drafts only.
  //   • window_closed = true  → past close: also discard still-unpaid
  //     online-payment (payment_required + 'upi') orders.
  const dueRoutes: RouteRow[] = await sql`
    SELECT
      r.id::text          AS id,
      r.name              AS name,
      tw.close_time::text AS close_time,
      (${nowIstTime}::time >= tw.close_time) AS window_closed
    FROM routes r
    JOIN time_windows tw ON tw.route_id = r.id
    WHERE tw.active = true
      AND (tw.close_time - make_interval(mins => tw.warning_minutes)) <= ${nowIstTime}::time
      AND ${nowIstTime}::time < (tw.close_time + interval '15 minutes')
  `;

  if (dueRoutes.length === 0) {
    return { routesMatched: 0, confirmed: 0, paymentRequired: 0, materialized: 0 };
  }

  console.log(
    `[AutoConfirm] ${dueRoutes.length} route(s) due (warning→close):`,
    dueRoutes
      .map((r) => `${r.name}@${r.close_time}${r.window_closed ? "(closed)" : "(warning)"}`)
      .join(", ")
  );

  let confirmed = 0;
  let paymentRequired = 0;
  let stockBlocked = 0;
  let minQtyBlocked = 0;
  let materialized = 0;
  let cancelledEmpty = 0;
  let discardedUnpaid = 0;
  let skipped = 0;
  let failed = 0;

  // Tally a confirm outcome into the right counter.
  const tally = (
    outcome: "confirmed" | "payment_required" | "stock_blocked" | "min_qty_blocked"
  ) => {
    if (outcome === "confirmed") confirmed++;
    else if (outcome === "payment_required") paymentRequired++;
    else if (outcome === "min_qty_blocked") minQtyBlocked++;
    else stockBlocked++;
  };

  // ── Build a draft order from the dealer's standing indent ──────────
  // Returns { orderId, grandTotal, itemCount } or null if the template
  // is empty (no active rows / all qty 0).
  async function materializeFromStanding(
    dealer: DealerRow
  ): Promise<{ orderId: string; grandTotal: number; itemCount: number } | null> {
    const items: StandingItem[] = await sql`
      SELECT
        dsi.product_id::text         AS product_id,
        dsi.default_qty              AS default_qty,
        p.name                       AS name,
        p.base_price::numeric::text  AS base_price,
        p.gst_percent::numeric::text AS gst_percent
      FROM dealer_standing_indents dsi
      JOIN products p ON p.id = dsi.product_id
                     AND p.deleted_at IS NULL
                     AND p.available = true
      WHERE dsi.dealer_id = ${dealer.dealer_id}::uuid
        AND dsi.active = true
        AND dsi.default_qty > 0
    `;
    if (items.length === 0) return null;

    let subtotal = 0;
    let totalGst = 0;
    let itemCount = 0;
    const lines = items.map((it) => {
      const price = parseFloat(it.base_price);
      const gstPct = parseFloat(it.gst_percent);
      const lineSub = price * it.default_qty;
      const lineGst = lineSub * (gstPct / 100);
      subtotal += lineSub;
      totalGst += lineGst;
      itemCount += it.default_qty;
      return {
        product_id: it.product_id,
        name: it.name,
        default_qty: it.default_qty,
        unitPrice: price.toFixed(2),
        gst_percent: gstPct.toFixed(2),
        gstAmount: lineGst.toFixed(2),
        lineTotal: (lineSub + lineGst).toFixed(2),
      };
    });
    const grandTotal = round2(subtotal + totalGst);

    const orderId = await sql.begin(async (tx) => {
      const [row] = await tx`
        INSERT INTO orders (
          dealer_id, zone_id, status, payment_mode,
          subtotal, total_gst, grand_total, item_count,
          delivery_date
        ) VALUES (
          ${dealer.dealer_id}::uuid, ${dealer.zone_id}::uuid, 'draft', 'credit',
          ${subtotal.toFixed(2)}::numeric,
          ${totalGst.toFixed(2)}::numeric,
          ${grandTotal.toFixed(2)}::numeric,
          ${itemCount},
          ${todayIso}::date
        )
        RETURNING id::text AS id
      `;
      for (const ln of lines) {
        await tx`
          INSERT INTO order_items (
            order_id, product_id, product_name, quantity,
            unit_price, gst_percent, gst_amount, line_total
          ) VALUES (
            ${row!.id}::uuid, ${ln.product_id}::uuid, ${ln.name},
            ${ln.default_qty}, ${ln.unitPrice}::numeric,
            ${ln.gst_percent}::numeric, ${ln.gstAmount}::numeric,
            ${ln.lineTotal}::numeric
          )
        `;
      }
      return row!.id;
    });

    return { orderId, grandTotal, itemCount };
  }

  // ── Confirm a draft order on credit (or flag payment_required) ─────
  // Mirrors POST /drafts/:date/confirm: writes the dealer_ledger debit
  // inside the same transaction so the books stay consistent. Returns
  // the outcome so the caller can bump counters + notify.
  async function confirmDraftOnCredit(
    dealer: DealerRow,
    orderId: string,
    grandTotal: number
  ): Promise<"confirmed" | "payment_required" | "stock_blocked" | "min_qty_blocked"> {
    // Notify the dealer their indent is on hold (best-effort).
    const sendStockBlockedNotice = async (names: string) => {
      if (dealer.notifications_enabled && dealer.fcm_token) {
        await notifQueue
          .add("stock-blocked", {
            event: "custom" as const,
            dealerId: dealer.dealer_id,
            orderId,
            title: "Indent on hold — out of stock ⚠️",
            body: `Out of stock: ${names}. Our team will sort it out shortly.`,
          })
          .catch((e) =>
            console.warn(`[AutoConfirm] notif failed for ${orderId}:`, e?.message)
          );
      }
    };

    // ── Min-order gate ── never auto-confirm an order whose Milk total is
    // below 12 L (curd has no minimum). Leave it a draft so the dealer/
    // admin can top up the standing indent, then it re-confirms on a later tick.
    const minShortfalls = await workerCategoryMinShortfalls(orderId);
    if (minShortfalls.length > 0) {
      console.warn(
        `[AutoConfirm] min-order-blocked order=${orderId} dealer=${dealer.dealer_id}: ` +
          minShortfalls.map((s) => `${s.category} ${s.total}${s.unit} < ${s.min}${s.unit}`).join(", ")
      );
      return "min_qty_blocked";
    }

    // ── Stock gate ── never auto-confirm what we can't physically deliver.
    // Leave the order a draft for manual resolution (a stock entry or a
    // quantity trim, then it re-confirms on a later tick / manually).
    const shortfalls = await workerStockShortfalls(orderId);
    if (shortfalls.length > 0) {
      console.warn(
        `[AutoConfirm] stock-blocked order=${orderId} dealer=${dealer.dealer_id}: ` +
          shortfalls
            .map((s) => `${s.productName}(need ${s.ordered}, have ${s.available})`)
            .join(", ")
      );
      await sendStockBlockedNotice(shortfalls.map((s) => s.productName).join(", "));
      return "stock_blocked";
    }

    const credit = await workerCreditCheck(dealer.dealer_id, grandTotal);

    if (!credit.sufficient) {
      await sql`
        UPDATE orders SET status = 'payment_required', updated_at = now()
         WHERE id = ${orderId}::uuid AND status = 'draft'
      `;
      if (dealer.notifications_enabled && dealer.fcm_token) {
        await notifQueue
          .add("payment-required", {
            event: "payment.reminder" as const,
            dealerId: dealer.dealer_id,
            orderId,
            title: "Payment required for today's indent ⚠️",
            body: `Short by ₹${credit.shortfall.toFixed(
              0
            )}. Top up credit or pay this order to confirm delivery.`,
          })
          .catch((e) =>
            console.warn(`[AutoConfirm] notif failed for ${orderId}:`, e?.message)
          );
      }
      return "payment_required";
    }

    // Sufficient credit → confirm + ledger debit + stock deduction,
    // atomically. A concurrent order draining stock since the gate above
    // makes the guarded deduction throw → full rollback, order stays draft.
    let applied = false;
    try {
    applied = await sql.begin(async (tx) => {
      // Auto-confirmed at close time → zero cancel grace (window is shut).
      const upd = await tx`
        UPDATE orders
           SET status       = 'confirmed',
               payment_mode = 'credit',
               confirmed_at  = COALESCE(confirmed_at, now()),
               cancel_window_ends_at = now(),
               updated_at    = now()
         WHERE id = ${orderId}::uuid AND status = 'draft'
      `;
      // Another tick (or the dealer) already moved it on — don't double-post.
      if (upd.count === 0) return false;

      const [bal] = await tx`
        SELECT
          COALESCE(d.opening_balance, 0)
          + COALESCE((SELECT SUM(CASE WHEN dl.type = 'credit'
                                       AND COALESCE(dl.voucher_type,'') <> 'Opening'
                                      THEN dl.amount ELSE 0 END)
                        FROM dealer_ledger dl WHERE dl.dealer_id = d.id), 0)
          - COALESCE((SELECT SUM(CASE WHEN dl.type = 'debit'
                                       AND COALESCE(dl.voucher_type,'') <> 'Opening'
                                      THEN dl.amount ELSE 0 END)
                        FROM dealer_ledger dl WHERE dl.dealer_id = d.id), 0)
          AS bal
        FROM dealers d WHERE d.id = ${dealer.dealer_id}::uuid
      `;
      const balanceAfter = parseFloat(bal!.bal) - grandTotal;

      await tx`
        INSERT INTO dealer_ledger
          (dealer_id, type, amount,
           reference_id, reference_type,
           voucher_type, voucher_date,
           description, balance_after)
        VALUES
          (${dealer.dealer_id}::uuid, 'debit', ${grandTotal.toFixed(2)}::numeric,
           ${orderId}::uuid, 'order',
           'Invoice', now()::date,
           ${"Auto-confirmed standing-indent order " + orderId},
           ${balanceAfter.toFixed(2)}::numeric)
      `;

      // Move physical stock last — its guard is what can abort the confirm.
      await deductOrderStockWorker(tx as unknown as typeof sql, orderId);
      return true;
    });
    } catch (err) {
      if (err instanceof WorkerStockConflict) {
        console.warn(
          `[AutoConfirm] stock-blocked (race) order=${orderId} dealer=${dealer.dealer_id}`
        );
        await sendStockBlockedNotice("some items");
        return "stock_blocked";
      }
      throw err;
    }

    if (!applied) return "confirmed"; // already handled by a prior tick

    await pdfQueue
      .add(`invoice-${orderId.slice(0, 8)}`, { orderId }, {
        removeOnComplete: 100,
        removeOnFail: 500,
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
      })
      .catch((e) =>
        console.warn(`[AutoConfirm] invoice enqueue failed for ${orderId}:`, e?.message)
      );

    if (dealer.notifications_enabled && dealer.fcm_token) {
      await notifQueue
        .add("indent-confirmed", {
          event: "order.confirmed" as const,
          dealerId: dealer.dealer_id,
          orderId,
          title: "Indent confirmed ✓",
          body: `Today's indent · ₹${grandTotal.toFixed(0)}. Out for delivery soon.`,
        })
        .catch((e) =>
          console.warn(`[AutoConfirm] notif failed for ${orderId}:`, e?.message)
        );
    }
    return "confirmed";
  }

  // ── Per-route → per-dealer ─────────────────────────────────────────
  for (const route of dueRoutes) {
    // Every active dealer on this route, with their most-recent order
    // for today (any status), pause flag, and whether they have an
    // active standing indent. One pass, no N+1 for the decision.
    const dealers: DealerRow[] = await sql`
      SELECT
        d.id::text              AS dealer_id,
        d.zone_id::text         AS zone_id,
        d.name                  AS dealer_name,
        d.fcm_token             AS fcm_token,
        d.notifications_enabled AS notifications_enabled,
        o.id::text              AS order_id,
        o.status::text          AS order_status,
        o.payment_mode::text    AS payment_mode,
        o.grand_total::numeric::text AS grand_total,
        o.item_count            AS item_count,
        (pause.dealer_id IS NOT NULL) AS paused,
        EXISTS (
          SELECT 1 FROM dealer_standing_indents dsi
           WHERE dsi.dealer_id = d.id
             AND dsi.active = true
             AND dsi.default_qty > 0
        ) AS has_standing
      FROM dealers d
      LEFT JOIN LATERAL (
        SELECT o2.id, o2.status, o2.payment_mode, o2.grand_total, o2.item_count
          FROM orders o2
         WHERE o2.dealer_id = d.id
           AND o2.delivery_date = ${todayIso}::date
         ORDER BY o2.created_at DESC
         LIMIT 1
      ) o ON true
      LEFT JOIN LATERAL (
        SELECT dip.dealer_id
          FROM dealer_indent_pauses dip
         WHERE dip.dealer_id = d.id
           AND ${todayIso}::date BETWEEN dip.from_date AND dip.to_date
         LIMIT 1
      ) pause ON true
      WHERE d.route_id = ${route.id}::uuid
        AND d.active = true
        AND d.deleted_at IS NULL
    `;

    if (dealers.length === 0) continue;

    for (const dealer of dealers) {
      try {
        if (dealer.paused) {
          skipped++;
          continue;
        }

        const status = dealer.order_status;

        // ── Existing draft → confirm (or cancel if empty) ────────────
        if (status === "draft" && dealer.order_id) {
          const grandTotal = parseFloat(dealer.grand_total ?? "0");
          if ((dealer.item_count ?? 0) === 0 || grandTotal === 0) {
            await sql`
              UPDATE orders
                 SET status = 'cancelled',
                     cancellation_reason = 'Empty draft at close time',
                     cancelled_at = now(),
                     updated_at = now()
               WHERE id = ${dealer.order_id}::uuid AND status = 'draft'
            `;
            cancelledEmpty++;
            continue;
          }
          const outcome = await confirmDraftOnCredit(
            dealer,
            dealer.order_id,
            grandTotal
          );
          tally(outcome);
          continue;
        }

        // ── Unpaid online-payment intent at/after close → discard ────
        // The dealer hit "Pay online" (so the order is payment_required
        // + 'upi') but never completed payment. They had until close to
        // pay; now the window has shut, so discard it instead of ever
        // placing it on credit. Only fires once close_time has passed.
        if (
          status === "payment_required" &&
          dealer.payment_mode === "upi" &&
          route.window_closed &&
          dealer.order_id
        ) {
          const cancelled = await sql`
            UPDATE orders
               SET status = 'cancelled',
                   cancellation_reason = 'Online payment not completed before window close',
                   cancelled_at = now(),
                   updated_at = now()
             WHERE id = ${dealer.order_id}::uuid
               AND status = 'payment_required'
               AND payment_mode = 'upi'
          `;
          if (cancelled.count > 0) {
            discardedUnpaid++;
            if (dealer.notifications_enabled && dealer.fcm_token) {
              await notifQueue
                .add("indent-discarded", {
                  event: "custom" as const,
                  dealerId: dealer.dealer_id,
                  orderId: dealer.order_id,
                  title: "Indent not placed — payment incomplete",
                  body: "Your online payment wasn't completed before the window closed, so today's indent wasn't placed.",
                })
                .catch((e) =>
                  console.warn(`[AutoConfirm] notif failed for ${dealer.order_id}:`, e?.message)
                );
            }
          }
          continue;
        }

        // ── Already placed / cancelled / awaiting payment → leave alone ─
        if (status !== null) {
          skipped++;
          continue;
        }

        // ── No order at all → materialise from standing, then confirm ─
        if (!dealer.has_standing) {
          skipped++;
          continue;
        }
        const built = await materializeFromStanding(dealer);
        if (!built) {
          skipped++;
          continue;
        }
        materialized++;
        const outcome = await confirmDraftOnCredit(
          dealer,
          built.orderId,
          built.grandTotal
        );
        tally(outcome);
      } catch (err: any) {
        failed++;
        console.error(
          `[AutoConfirm] dealer=${dealer.dealer_id} (${dealer.dealer_name}) failed:`,
          err?.message ?? err
        );
        // One dealer's failure must not stop the batch.
      }
    }
  }

  // ── Employee pass (no app / no FCM / no PDF) ───────────────────────
  // Same close-time routes; employees are route-assigned (migration 0037).
  // Materialise-then-confirm from the employee standing indent at subsidy
  // pricing. Over-limit → 'payment_required' (finance releases later).
  let empConfirmed = 0;
  let empPaymentRequired = 0;
  let empMaterialized = 0;
  let empCancelledEmpty = 0;
  let empSkipped = 0;
  let empFailed = 0;

  // Build a draft employee_order from the standing indent. null if empty.
  async function materializeEmployeeFromStanding(
    employeeId: string,
    routeId: string
  ): Promise<{ orderId: string; grandTotal: number } | null> {
    const items: Array<{
      product_id: string; default_qty: number; name: string;
      base_price: string; gst_percent: string; subsidy_price: string;
    }> = await sql`
      SELECT
        esi.product_id::text         AS product_id,
        esi.default_qty              AS default_qty,
        p.name                       AS name,
        p.base_price::numeric::text  AS base_price,
        p.gst_percent::numeric::text AS gst_percent,
        r.subsidy_price::numeric::text AS subsidy_price
      FROM employee_standing_indents esi
      JOIN products p ON p.id = esi.product_id
                     AND p.deleted_at IS NULL AND p.available = true
      JOIN employee_subsidy_rules r ON r.product_id = esi.product_id AND r.active = true
      WHERE esi.employee_id = ${employeeId}::uuid
        AND esi.active = true AND esi.default_qty > 0
    `;
    if (items.length === 0) return null;

    let subtotal = 0;
    let totalGst = 0;
    let itemCount = 0;
    const lines = items.map((it) => {
      const mrp = parseFloat(it.base_price);
      const empPrice = parseFloat(it.subsidy_price);   // GST-inclusive employee price
      const gstPct = parseFloat(it.gst_percent);
      const unitPrice = round2(empPrice / (1 + gstPct / 100));
      const lineTotal = round2(empPrice * it.default_qty);
      const lineSub = round2(unitPrice * it.default_qty);
      const lineGst = round2(lineTotal - lineSub);
      const effPct = mrp > 0 ? round2((1 - unitPrice / mrp) * 100) : 0;
      subtotal += lineSub;
      totalGst += lineGst;
      itemCount += it.default_qty;
      return {
        product_id: it.product_id, name: it.name, default_qty: it.default_qty,
        unitPrice: unitPrice.toFixed(2), gst_percent: gstPct.toFixed(2),
        gstAmount: lineGst.toFixed(2), lineTotal: lineTotal.toFixed(2),
        subsidy_percent: effPct.toFixed(2), mrp_reference: mrp.toFixed(2),
      };
    });
    const grandTotal = round2(subtotal + totalGst);

    const orderId = await sql.begin(async (tx) => {
      const [row] = await tx`
        INSERT INTO employee_orders (
          employee_id, route_id, status, payment_mode,
          subtotal, total_gst, grand_total, item_count, delivery_date
        ) VALUES (
          ${employeeId}::uuid, ${routeId}::uuid, 'draft', 'credit',
          ${subtotal.toFixed(2)}::numeric, ${totalGst.toFixed(2)}::numeric,
          ${grandTotal.toFixed(2)}::numeric, ${itemCount}, ${todayIso}::date
        )
        RETURNING id::text AS id
      `;
      for (const ln of lines) {
        await tx`
          INSERT INTO employee_order_items (
            employee_order_id, product_id, product_name, quantity,
            unit_price, gst_percent, gst_amount, line_total,
            subsidy_percent, mrp_reference
          ) VALUES (
            ${row!.id}::uuid, ${ln.product_id}::uuid, ${ln.name},
            ${ln.default_qty}, ${ln.unitPrice}::numeric, ${ln.gst_percent}::numeric,
            ${ln.gstAmount}::numeric, ${ln.lineTotal}::numeric,
            ${ln.subsidy_percent}::numeric, ${ln.mrp_reference}::numeric
          )
        `;
      }
      return row!.id;
    });
    return { orderId, grandTotal };
  }

  // Confirm an employee draft on credit, or flag payment_required.
  async function confirmEmployeeOnCredit(
    employeeId: string,
    orderId: string,
    grandTotal: number
  ): Promise<"confirmed" | "payment_required"> {
    const credit = await workerEmployeeCreditCheck(employeeId, grandTotal);
    if (!credit.sufficient) {
      await sql`
        UPDATE employee_orders SET status = 'payment_required', updated_at = now()
         WHERE id = ${orderId}::uuid AND status = 'draft'
      `;
      return "payment_required";
    }
    await sql.begin(async (tx) => {
      const upd = await tx`
        UPDATE employee_orders
           SET status = 'confirmed', payment_mode = 'credit',
               confirmed_at = COALESCE(confirmed_at, now()), updated_at = now()
         WHERE id = ${orderId}::uuid AND status = 'draft'
      `;
      if (upd.count === 0) return;
      const [bal] = await tx`
        SELECT
          COALESCE(e.opening_balance, 0)
          + COALESCE((SELECT SUM(CASE WHEN el.type = 'credit'
                                       AND COALESCE(el.voucher_type,'') <> 'Opening'
                                      THEN el.amount ELSE 0 END)
                        FROM employee_ledger el WHERE el.employee_id = e.id), 0)
          - COALESCE((SELECT SUM(CASE WHEN el.type = 'debit'
                                       AND COALESCE(el.voucher_type,'') <> 'Opening'
                                      THEN el.amount ELSE 0 END)
                        FROM employee_ledger el WHERE el.employee_id = e.id), 0)
          AS bal
        FROM employees e WHERE e.id = ${employeeId}::uuid
      `;
      const balanceAfter = parseFloat(bal!.bal) - grandTotal;
      await tx`
        INSERT INTO employee_ledger
          (employee_id, type, amount, reference_id, reference_type,
           voucher_type, voucher_date, description, balance_after)
        VALUES
          (${employeeId}::uuid, 'debit', ${grandTotal.toFixed(2)}::numeric,
           ${orderId}::uuid, 'order', 'Invoice', now()::date,
           ${"Auto-confirmed employee standing-indent order " + orderId},
           ${balanceAfter.toFixed(2)}::numeric)
      `;
    });
    return "confirmed";
  }

  for (const route of dueRoutes) {
    const emps: Array<{
      employee_id: string; order_id: string | null; order_status: string | null;
      grand_total: string | null; item_count: number | null; has_standing: boolean;
    }> = await sql`
      SELECT
        e.id::text                   AS employee_id,
        o.id::text                   AS order_id,
        o.status::text               AS order_status,
        o.grand_total::numeric::text AS grand_total,
        o.item_count                 AS item_count,
        EXISTS (
          SELECT 1 FROM employee_standing_indents esi
          JOIN employee_subsidy_rules r ON r.product_id = esi.product_id AND r.active = true
           WHERE esi.employee_id = e.id AND esi.active = true AND esi.default_qty > 0
        ) AS has_standing
      FROM employees e
      LEFT JOIN LATERAL (
        SELECT eo.id, eo.status, eo.grand_total, eo.item_count
          FROM employee_orders eo
         WHERE eo.employee_id = e.id AND eo.delivery_date = ${todayIso}::date
         ORDER BY eo.created_at DESC LIMIT 1
      ) o ON true
      WHERE e.route_id = ${route.id}::uuid
        AND e.active = true AND e.deleted_at IS NULL
    `;

    for (const emp of emps) {
      try {
        const status = emp.order_status;
        if (status === "draft" && emp.order_id) {
          const grandTotal = parseFloat(emp.grand_total ?? "0");
          if ((emp.item_count ?? 0) === 0 || grandTotal === 0) {
            await sql`
              UPDATE employee_orders
                 SET status = 'cancelled',
                     cancellation_reason = 'Empty draft at close time',
                     cancelled_at = now(), updated_at = now()
               WHERE id = ${emp.order_id}::uuid AND status = 'draft'
            `;
            empCancelledEmpty++;
            continue;
          }
          const outcome = await confirmEmployeeOnCredit(emp.employee_id, emp.order_id, grandTotal);
          outcome === "confirmed" ? empConfirmed++ : empPaymentRequired++;
          continue;
        }
        if (status !== null) {
          empSkipped++;
          continue;
        }
        if (!emp.has_standing) {
          empSkipped++;
          continue;
        }
        const built = await materializeEmployeeFromStanding(emp.employee_id, route.id);
        if (!built) {
          empSkipped++;
          continue;
        }
        empMaterialized++;
        const outcome = await confirmEmployeeOnCredit(emp.employee_id, built.orderId, built.grandTotal);
        outcome === "confirmed" ? empConfirmed++ : empPaymentRequired++;
      } catch (err: any) {
        empFailed++;
        console.error(`[AutoConfirm] employee=${emp.employee_id} failed:`, err?.message ?? err);
      }
    }
  }

  // Shared queues are long-lived — closed once on worker shutdown.

  const summary = {
    routesMatched: dueRoutes.length,
    confirmed,
    paymentRequired,
    stockBlocked,
    minQtyBlocked,
    materialized,
    cancelledEmpty,
    discardedUnpaid,
    skipped,
    failed,
    employees: {
      confirmed: empConfirmed,
      paymentRequired: empPaymentRequired,
      materialized: empMaterialized,
      cancelledEmpty: empCancelledEmpty,
      skipped: empSkipped,
      failed: empFailed,
    },
  };
  console.log(`[AutoConfirm] Done:`, summary);
  return summary;
}
