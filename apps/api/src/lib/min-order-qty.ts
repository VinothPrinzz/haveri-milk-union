// apps/api/src/lib/min-order-qty.ts
// ═══════════════════════════════════════════════════════════════════════
// Per-line minimum order quantity for restricted categories.
//
// Business rule: products in the "Milk" and "Curd" categories cannot be
// ordered in quantities below 6 (units). A line is acceptable only when
// its quantity is 0 (not ordered) or >= 6. This is enforced PER ORDER
// LINE — each Milk/Curd product must individually reach the minimum.
//
// This is the single source of truth for the rule on the API side; every
// order-placement / draft-confirm endpoint calls into it so the guarantee
// holds no matter which surface (dealer app, admin panel, call desk) the
// order came from.
// ═══════════════════════════════════════════════════════════════════════

import { pgClient } from "./db.js";

/** Minimum quantity (inclusive) for a restricted-category line. qty 6 passes; 1–5 fail. */
export const MIN_ORDER_QTY = 6;

/** Category names (compared case-insensitively) the minimum applies to. */
export const MIN_QTY_CATEGORY_NAMES = ["milk", "curd"] as const;

export interface MinQtyViolation {
  productId: string;
  productName: string;
  categoryName: string;
  quantity: number;
}

/** Human-readable, list-y message naming the offending lines. */
export function minQtyErrorMessage(violations: MinQtyViolation[]): string {
  const list = violations
    .map((v) => `${v.productName} (${v.categoryName} · qty ${v.quantity})`)
    .join(", ");
  return (
    `Milk & Curd products must be ordered in quantities of ${MIN_ORDER_QTY} or more per item. ` +
    `Increase or remove: ${list}.`
  );
}

/**
 * Given raw {productId, quantity} lines, return the ones that break the
 * per-line minimum: the product's category is restricted (Milk/Curd) AND
 * 0 < quantity < MIN_ORDER_QTY. Lines with quantity 0 are ignored — the
 * product simply isn't being ordered.
 */
export async function findMinQtyViolations(
  items: Array<{ productId: string; quantity: number }>
): Promise<MinQtyViolation[]> {
  const offending = items.filter(
    (i) => i.quantity > 0 && i.quantity < MIN_ORDER_QTY
  );
  if (offending.length === 0) return [];

  const ids = offending.map((i) => i.productId);
  const rows = (await pgClient`
    SELECT p.id::text AS id, p.name AS name, c.name AS category_name
      FROM products p
      JOIN categories c ON c.id = p.category_id
     WHERE p.id = ANY(${ids}::uuid[])
       AND lower(c.name) = ANY(${MIN_QTY_CATEGORY_NAMES as unknown as string[]}::text[])
  `) as Array<{ id: string; name: string; category_name: string }>;

  const restricted = new Map(rows.map((r) => [r.id, r]));
  const out: MinQtyViolation[] = [];
  for (const i of offending) {
    const r = restricted.get(i.productId);
    if (r) {
      out.push({
        productId: i.productId,
        productName: r.name,
        categoryName: r.category_name,
        quantity: i.quantity,
      });
    }
  }
  return out;
}

/**
 * Same per-line check, but against an order's already-persisted line items.
 * Used by the draft-confirm endpoints, which only hold an orderId by the
 * time the order is being placed.
 */
export async function findOrderMinQtyViolations(
  orderId: string
): Promise<MinQtyViolation[]> {
  const rows = (await pgClient`
    SELECT oi.product_id::text AS id,
           oi.product_name     AS name,
           c.name              AS category_name,
           oi.quantity         AS quantity
      FROM order_items oi
      JOIN products p   ON p.id = oi.product_id
      JOIN categories c ON c.id = p.category_id
     WHERE oi.order_id = ${orderId}::uuid
       AND oi.quantity > 0
       AND oi.quantity < ${MIN_ORDER_QTY}
       AND lower(c.name) = ANY(${MIN_QTY_CATEGORY_NAMES as unknown as string[]}::text[])
  `) as Array<{ id: string; name: string; category_name: string; quantity: number }>;

  return rows.map((r) => ({
    productId: r.id,
    productName: r.name,
    categoryName: r.category_name,
    quantity: Number(r.quantity),
  }));
}
