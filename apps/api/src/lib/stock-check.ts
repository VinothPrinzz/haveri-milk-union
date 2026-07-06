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
// Invariant: products.stock can never go negative. Every deduction is a
// guarded UPDATE (... WHERE stock >= qty); a guard that matches no row
// means a concurrent order drained stock between the pre-check and the
// deduction, and we abort the whole confirm by throwing StockConflictError.
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
 * Pure read — which of an order's lines exceed current product stock.
 * Empty array → every line is fully coverable right now. Use this before
 * a confirm to surface a friendly error and leave the draft editable.
 */
export async function getOrderStockShortfalls(
  client: typeof pgClient,
  orderId: string
): Promise<StockShortfall[]> {
  // A variant SKU (e.g. the HTM 1000ML subsidy line) draws its stock from a
  // base SKU via products.stock_source_product_id — resolve to that row's
  // stock, not the variant's own (which stays 0). See migration 0059.
  const rows = await client`
    SELECT oi.product_id::text AS "productId",
           oi.product_name     AS "productName",
           oi.quantity         AS "ordered",
           sp.stock            AS "available"
      FROM order_items oi
      JOIN products p  ON p.id = oi.product_id
      JOIN products sp ON sp.id = COALESCE(p.stock_source_product_id, p.id)
     WHERE oi.order_id = ${orderId}::uuid
       AND oi.quantity > sp.stock
  `;
  return (rows as any[]).map((r) => ({
    productId: r.productId,
    productName: r.productName,
    ordered: Number(r.ordered),
    available: Number(r.available),
  }));
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
 * Deduct every order line from products.stock, guarded so stock can never
 * go negative even under concurrent confirms. MUST run inside a
 * transaction — pass the tx client. Idempotent: a no-op if the order was
 * already deducted. Throws StockConflictError (rolling the transaction
 * back, which also releases the latch) if any line can't be satisfied.
 *
 * Use this on PRE-payment confirms, where blocking is the right answer.
 */
export async function deductOrderStock(
  tx: typeof pgClient,
  orderId: string
): Promise<void> {
  if (!(await claimDeduction(tx, orderId))) return; // already deducted
  // stockProductId resolves a variant SKU to its base SKU's stock row
  // (COALESCE(stock_source_product_id, id)); deduct there. See migration 0059.
  const items = await tx`
    SELECT oi.product_id::text AS "productId",
           oi.product_name     AS "productName",
           oi.quantity         AS "quantity",
           COALESCE(p.stock_source_product_id, p.id)::text AS "stockProductId"
      FROM order_items oi
      JOIN products p ON p.id = oi.product_id
     WHERE oi.order_id = ${orderId}::uuid
  `;
  for (const it of items as any[]) {
    const updated = await tx`
      UPDATE products
         SET stock = stock - ${it.quantity}, updated_at = now()
       WHERE id = ${it.stockProductId}::uuid
         AND stock >= ${it.quantity}
      RETURNING id
    `;
    if (updated.count === 0) {
      const [cur] = await tx`
        SELECT stock FROM products WHERE id = ${it.stockProductId}::uuid
      `;
      throw new StockConflictError([
        {
          productId: it.productId,
          productName: it.productName,
          ordered: Number(it.quantity),
          available: cur ? Number(cur.stock) : 0,
        },
      ]);
    }
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
  // Variant SKUs draw from their base SKU's stock row (migration 0059).
  const items = await tx`
    SELECT oi.product_id::text AS "productId",
           oi.product_name     AS "productName",
           oi.quantity         AS "quantity",
           sp.stock            AS "available",
           sp.id::text         AS "stockProductId"
      FROM order_items oi
      JOIN products p  ON p.id = oi.product_id
      JOIN products sp ON sp.id = COALESCE(p.stock_source_product_id, p.id)
     WHERE oi.order_id = ${orderId}::uuid
  `;
  const oversold: StockShortfall[] = [];
  for (const it of items as any[]) {
    if (Number(it.available) < Number(it.quantity)) {
      oversold.push({
        productId: it.productId,
        productName: it.productName,
        ordered: Number(it.quantity),
        available: Number(it.available),
      });
    }
    await tx`
      UPDATE products
         SET stock = GREATEST(stock - ${it.quantity}, 0), updated_at = now()
       WHERE id = ${it.stockProductId}::uuid
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
