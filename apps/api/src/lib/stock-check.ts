// ═══════════════════════════════════════════════════════════════════════
// apps/api/src/lib/stock-check.ts
//
// Single source of truth for "does this order's stock add up?" and for
// moving products.stock when an order is placed or cancelled.
//
// Stock is deducted at the moment a draft/order becomes a real (confirmed
// or payment_required) order — NOT at dispatch — mirroring the Call Desk
// POST /api/v1/orders path, which already validates + deducts on create.
// Cancellation restores it (see cancelOrderWithReversal).
//
// Two stock figures exist and they DISAGREE:
//   • fgsAvailable() below — the day-aware FGS availability the dealer app's
//     product list shows (opening + received − wastage − live reservations).
//   • products.stock — a free-floating counter that drifts (it carries across
//     days and for any SKU set outside the morning Stock Entry flow).
// Gating an order on products.stock is what wrongly blocked SKUs that had real
// stock (the SAMRUDHI incident — home page showed 3580, the counter had
// drifted to 16). fgsAvailable is the number to gate on.
//
// EVERY confirm path now gates on fgsAvailable and serializes concurrent
// confirms on a per-product advisory lock (lockStockProducts) so the check
// can't be raced into overselling: dealer-app checkout (orders.ts), Call Desk
// + standing indents (deductOrderStock), Razorpay pay-now (deductOrderStockCapped,
// which caps instead of blocking since money is already captured). The reserved
// side of fgsAvailable counts an order the moment stock_deducted latches, so a
// confirm reserves against the next reader automatically — products.stock is
// now VESTIGIAL bookkeeping, kept roughly maintained (floored, ungated) only
// for legacy readers, never a gate. Retiring it is a later cleanup.
//
// Ordering rule: a confirm must free the dealer's superseded siblings
// (cancelSupersededSiblings → restoreOrderStock) BEFORE the stock check, or the
// sibling's still-live reservation double-counts against this order. The
// confirm flows call supersede first for exactly this reason.
// ═══════════════════════════════════════════════════════════════════════

import { pgClient } from "./db.js";

export interface StockShortfall {
  productId: string;
  productName: string;
  ordered: number;
  available: number;
}

/**
 * Thrown by deductOrderStock when a line cannot be satisfied (e.g. a
 * concurrent order drained stock between the pre-check and the guarded
 * deduction). Throwing inside a transaction rolls the whole confirm back,
 * leaving the order untouched (still a draft).
 */
export class StockConflictError extends Error {
  statusCode = 409;
  shortfalls: StockShortfall[];
  constructor(shortfalls: StockShortfall[]) {
    super("Insufficient stock");
    this.name = "StockConflictError";
    this.shortfalls = shortfalls;
  }
}

/** Human-readable summary of a shortfall list, for API error messages. */
export function describeShortfalls(shortfalls: StockShortfall[]): string {
  return shortfalls
    .map((s) => `${s.productName} (need ${s.ordered}, have ${s.available})`)
    .join(", ");
}

/**
 * Day-aware available quantity for ONE stock-owning product, computed from the
 * FGS daily model — the SAME formula the dealer app's product list uses
 * (productRoutes GET /products). This is the number the dealer sees, so an
 * order gate must agree with it rather than with the drifting products.stock
 * counter:
 *
 *   opening (today's fgs_stock_log, else the most recent prior day's closing,
 *            else 0)  + received − wastage
 *   − reservations already claimed by live orders for today's delivery
 *     (every order with stock_deducted = true, keyed to the stock-owning SKU).
 *
 * Pass the STOCK product id — resolve a variant to its base with
 * COALESCE(stock_source_product_id, id) first (migration 0059). Returns the
 * RAW, possibly-negative figure so callers can both display it (floor at 0)
 * and, once an order is latched, read < 0 as oversell. Scalar param only →
 * safe through the Supabase transaction pooler (array-bound params crash Bind
 * there). Works with pgClient or a transaction client.
 */
export async function fgsAvailable(
  client: typeof pgClient,
  stockProductId: string
): Promise<number> {
  const [row] = await client`
    WITH today AS (SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date AS d),
    reserved AS (
      SELECT COALESCE(SUM(oi.quantity), 0)::int AS qty
        FROM orders o
        JOIN order_items oi ON oi.order_id = o.id
        JOIN products pp    ON pp.id = oi.product_id
       WHERE o.delivery_date = (SELECT d FROM today)
         AND o.stock_deducted = true
         AND COALESCE(pp.stock_source_product_id, pp.id) = ${stockProductId}::uuid
    )
    SELECT (
        COALESCE(
          fsl.opening,
          (SELECT prev.closing
             FROM fgs_stock_log prev
            WHERE prev.product_id = ${stockProductId}::uuid
              AND prev.date < (SELECT d FROM today)
            ORDER BY prev.date DESC
            LIMIT 1),
          0
        )
        + COALESCE(fsl.received, 0)
        - COALESCE(fsl.wastage, 0)
        - (SELECT qty FROM reserved)
      )::int AS available
      FROM (SELECT 1) _one
      LEFT JOIN fgs_stock_log fsl
             ON fsl.product_id = ${stockProductId}::uuid
            AND fsl.date = (SELECT d FROM today)
  `;
  return Number((row as any)?.available ?? 0);
}

/**
 * Serialize concurrent confirms that touch the same stock product, so the
 * fgsAvailable re-check below can't be raced into overselling: two orders
 * competing for the last units of a SKU are forced to check one-after-another,
 * and the second sees the first's committed reservation. Transaction-scoped
 * advisory locks (auto-released at commit/rollback → safe with the Supabase
 * transaction pooler). Locked in sorted id order so two orders that share
 * products can't deadlock. MUST run inside a transaction; scalar param per
 * product (array params crash Bind through the pooler), and orders touch only
 * a handful of distinct products so the round-trips are negligible.
 */
export async function lockStockProducts(
  tx: typeof pgClient,
  stockProductIds: string[]
): Promise<void> {
  const ordered = [...new Set(stockProductIds)].sort();
  for (const id of ordered) {
    await tx`SELECT pg_advisory_xact_lock(hashtext('order-stock'), hashtext(${id}))`;
  }
}

/**
 * Pure read — which of an order's lines exceed the day-aware FGS availability
 * the dealer sees. Empty array → every line is fully coverable right now. Use
 * this before a confirm to surface a friendly error and leave the draft
 * editable. (Advisory: the authoritative, race-safe gate is deductOrderStock,
 * which re-checks under a lock inside the transaction.)
 */
export async function getOrderStockShortfalls(
  client: typeof pgClient,
  orderId: string
): Promise<StockShortfall[]> {
  // Sum this order's demand per STOCK product — a variant SKU (e.g. the HTM
  // 1000ML subsidy line) draws from its base via stock_source_product_id
  // (migration 0059), so a variant and its base collapse onto one row — then
  // compare against the day-aware FGS availability the dealer sees, NOT the
  // drifting products.stock counter.
  const lines = await client`
    SELECT COALESCE(p.stock_source_product_id, p.id)::text AS "stockProductId",
           MIN(oi.product_name)                            AS "productName",
           SUM(oi.quantity)::int                           AS "ordered"
      FROM order_items oi
      JOIN products p ON p.id = oi.product_id
     WHERE oi.order_id = ${orderId}::uuid
     GROUP BY COALESCE(p.stock_source_product_id, p.id)
  `;
  const shortfalls: StockShortfall[] = [];
  for (const l of lines as any[]) {
    const available = await fgsAvailable(client, l.stockProductId);
    if (Number(l.ordered) > available) {
      shortfalls.push({
        productId: l.stockProductId,
        productName: l.productName,
        ordered: Number(l.ordered),
        available,
      });
    }
  }
  return shortfalls;
}

/**
 * Claim the deduction latch (orders.stock_deducted false → true). Returns
 * true if THIS call won the claim (deduction should proceed), false if the
 * order was already deducted (idempotent no-op for the caller).
 */
async function claimDeduction(
  tx: typeof pgClient,
  orderId: string
): Promise<boolean> {
  const claimed = await tx`
    UPDATE orders SET stock_deducted = true, updated_at = now()
     WHERE id = ${orderId}::uuid AND stock_deducted = false
    RETURNING id
  `;
  return claimed.count > 0;
}

/**
 * Confirm an order against the day-aware FGS availability, blocking if it
 * would oversell today's stock. MUST run inside a transaction — pass the tx
 * client. Idempotent: a no-op if the order was already deducted. Throws
 * StockConflictError (rolling the transaction back, which also releases the
 * latch) if any line can't be satisfied.
 *
 * Use this on PRE-payment confirms, where blocking is the right answer. The
 * caller MUST have already freed the dealer's superseded siblings (see the
 * ordering rule at the top of this file).
 */
export async function deductOrderStock(
  tx: typeof pgClient,
  orderId: string
): Promise<void> {
  if (!(await claimDeduction(tx, orderId))) return; // already deducted
  // Demand per STOCK product — a variant SKU draws from its base SKU's row
  // (COALESCE(stock_source_product_id, id), migration 0059).
  const lines = await tx`
    SELECT COALESCE(p.stock_source_product_id, p.id)::text AS "stockProductId",
           MIN(oi.product_name)                            AS "productName",
           SUM(oi.quantity)::int                           AS "ordered"
      FROM order_items oi
      JOIN products p ON p.id = oi.product_id
     WHERE oi.order_id = ${orderId}::uuid
     GROUP BY COALESCE(p.stock_source_product_id, p.id)
  `;
  // Serialize on these products, then verify. The claim above latched
  // stock_deducted = true, so fgsAvailable now COUNTS this order against
  // today's FGS stock — a negative remainder means it oversells.
  await lockStockProducts(
    tx,
    (lines as any[]).map((l) => l.stockProductId)
  );
  const shortfalls: StockShortfall[] = [];
  for (const l of lines as any[]) {
    const remaining = await fgsAvailable(tx, l.stockProductId); // counts this order
    if (remaining < 0) {
      shortfalls.push({
        productId: l.stockProductId,
        productName: l.productName,
        ordered: Number(l.ordered),
        available: Number(l.ordered) + remaining, // availability before this order
      });
    }
  }
  if (shortfalls.length > 0) throw new StockConflictError(shortfalls);
  // Legacy bookkeeping only: keep products.stock roughly maintained for any
  // reader still on the raw counter, floored + UNGATED so the drifting counter
  // can never block (the FGS check above is the authority).
  for (const l of lines as any[]) {
    await tx`
      UPDATE products
         SET stock = GREATEST(stock - ${l.ordered}, 0), updated_at = now()
       WHERE id = ${l.stockProductId}::uuid
    `;
  }
}

/**
 * Like deductOrderStock but NEVER throws and NEVER lets stock go negative
 * (floors each line at 0). Returns the lines that couldn't be fully
 * covered (oversold), for the caller to log/alert. Idempotent.
 *
 * Use this AFTER money is captured (Razorpay pay-now): refusing a paid
 * order is worse than a logged oversell, so we cap rather than block.
 */
export async function deductOrderStockCapped(
  tx: typeof pgClient,
  orderId: string
): Promise<StockShortfall[]> {
  if (!(await claimDeduction(tx, orderId))) return []; // already deducted
  // Demand per STOCK product — variant SKUs draw from their base (migration 0059).
  const lines = await tx`
    SELECT COALESCE(p.stock_source_product_id, p.id)::text AS "stockProductId",
           MIN(oi.product_name)                            AS "productName",
           SUM(oi.quantity)::int                           AS "ordered"
      FROM order_items oi
      JOIN products p ON p.id = oi.product_id
     WHERE oi.order_id = ${orderId}::uuid
     GROUP BY COALESCE(p.stock_source_product_id, p.id)
  `;
  const oversold: StockShortfall[] = [];
  for (const l of lines as any[]) {
    // The claim latched this order into the FGS reservation; a negative
    // remainder means it oversold today's stock. We DON'T block (money is
    // already captured) — just report it for the caller to alert on. No
    // advisory lock either: never blocking, so racing can only mis-log by a
    // hair, never oversell-vs-refuse.
    const remaining = await fgsAvailable(tx, l.stockProductId);
    if (remaining < 0) {
      oversold.push({
        productId: l.stockProductId,
        productName: l.productName,
        ordered: Number(l.ordered),
        available: Number(l.ordered) + remaining, // availability before this order
      });
    }
    await tx`
      UPDATE products
         SET stock = GREATEST(stock - ${l.ordered}, 0), updated_at = now()
       WHERE id = ${l.stockProductId}::uuid
    `;
  }
  return oversold;
}

/**
 * Restore every order line back to products.stock — the inverse of
 * deductOrderStock. MUST run inside a transaction. Idempotent: only
 * restores if the order is currently flagged as deducted (clears the
 * flag). Called from the cancel helper so every cancellation (self-service
 * or admin) puts stock back exactly once.
 */
export async function restoreOrderStock(
  tx: typeof pgClient,
  orderId: string
): Promise<void> {
  const released = await tx`
    UPDATE orders SET stock_deducted = false, updated_at = now()
     WHERE id = ${orderId}::uuid AND stock_deducted = true
    RETURNING id
  `;
  if (released.count === 0) return; // never deducted — nothing to restore
  // Restore to the same row the deduction targeted — a variant SKU's base
  // SKU (COALESCE(stock_source_product_id, id)). See migration 0059.
  const items = await tx`
    SELECT COALESCE(p.stock_source_product_id, p.id)::text AS "stockProductId",
           oi.quantity AS "quantity"
      FROM order_items oi
      JOIN products p ON p.id = oi.product_id
     WHERE oi.order_id = ${orderId}::uuid
  `;
  for (const it of items as any[]) {
    await tx`
      UPDATE products
         SET stock = stock + ${it.quantity}, updated_at = now()
       WHERE id = ${it.stockProductId}::uuid
    `;
  }
}
