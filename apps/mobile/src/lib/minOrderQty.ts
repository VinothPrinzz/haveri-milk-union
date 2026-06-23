// src/lib/minOrderQty.ts
//
// Per-line minimum order quantity for restricted categories (Milk & Curd).
//
// Business rule: a Milk or Curd product can only be ordered in quantities
// of 6 or more. The dealer can order 0 (not at all) or ≥6 — never 1–5.
// This mirrors the server guard in apps/api/src/lib/min-order-qty.ts; the
// server is the source of truth, this is the matching client-side UX so the
// dealer never builds an order the backend will reject.

/** Minimum quantity (inclusive) for a restricted-category line. 6 passes; 1–5 fail. */
export const MIN_ORDER_QTY = 6;

/** Category names (compared case-insensitively) the minimum applies to. */
const RESTRICTED_CATEGORIES = new Set(["milk", "curd"]);

/** True when a product's category is subject to the minimum-order-qty rule. */
export function isMinQtyCategory(categoryName?: string | null): boolean {
  return !!categoryName && RESTRICTED_CATEGORIES.has(categoryName.trim().toLowerCase());
}

/** The minimum quantity for a category: 6 for Milk/Curd, otherwise 1. */
export function minQtyFor(categoryName?: string | null): number {
  return isMinQtyCategory(categoryName) ? MIN_ORDER_QTY : 1;
}

/**
 * Snap a requested quantity to a legal value for the product's category:
 *   • 0 stays 0 (removes the item)
 *   • for Milk/Curd, 1–5 bumps up to the minimum (6)
 *   • everything else passes through unchanged
 */
export function snapQtyToMin(qty: number, categoryName?: string | null): number {
  if (qty <= 0) return 0;
  const min = minQtyFor(categoryName);
  return qty < min ? min : qty;
}

/** A line that breaks the rule (Milk/Curd with 0 < quantity < 6). */
export interface MinQtyLine {
  name: string;
  categoryName?: string | null;
  quantity: number;
}

/** Returns the offending lines, or [] when the order is compliant. */
export function findMinQtyViolations<T extends MinQtyLine>(lines: T[]): T[] {
  return lines.filter(
    (l) =>
      isMinQtyCategory(l.categoryName) &&
      l.quantity > 0 &&
      l.quantity < MIN_ORDER_QTY
  );
}

/** Friendly, list-y message naming the offending lines. */
export function minQtyMessage(lines: MinQtyLine[]): string {
  const list = lines.map((l) => `${l.name} (${l.quantity})`).join(", ");
  return `Milk & Curd items must be ordered in 6 or more. Increase or remove: ${list}.`;
}
