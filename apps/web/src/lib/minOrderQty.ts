// src/lib/minOrderQty.ts
//
// Per-line minimum order quantity for restricted categories (Milk & Curd).
//
// Business rule: a Milk or Curd product can only be ordered in quantities
// of 6 or more — never 1–5. Mirrors the server guard in
// apps/api/src/lib/min-order-qty.ts (the source of truth); this is the
// matching client-side guard so the operator can't submit an order the
// backend will reject.

/** Minimum quantity (inclusive) for a restricted-category line. 6 passes; 1–5 fail. */
export const MIN_ORDER_QTY = 6;

/** Category names (compared case-insensitively) the minimum applies to. */
const RESTRICTED_CATEGORIES = new Set(["milk", "curd"]);

/** True when a product's category is subject to the minimum-order-qty rule. */
export function isMinQtyCategory(categoryName?: string | null): boolean {
  return !!categoryName && RESTRICTED_CATEGORIES.has(categoryName.trim().toLowerCase());
}

/** True when this line breaks the rule (Milk/Curd with 0 < quantity < 6). */
export function violatesMinQty(
  categoryName: string | null | undefined,
  quantity: number
): boolean {
  return isMinQtyCategory(categoryName) && quantity > 0 && quantity < MIN_ORDER_QTY;
}

/** A line that breaks the rule. */
export interface MinQtyLine {
  name: string;
  categoryName?: string | null;
  quantity: number;
}

/** Returns the offending lines, or [] when compliant. */
export function findMinQtyViolations<T extends MinQtyLine>(lines: T[]): T[] {
  return lines.filter((l) => violatesMinQty(l.categoryName, l.quantity));
}

/** Friendly, list-y message naming the offending lines. */
export function minQtyMessage(lines: MinQtyLine[]): string {
  const list = lines.map((l) => `${l.name} (${l.quantity})`).join(", ");
  return `Milk & Curd items must be ordered in ${MIN_ORDER_QTY} or more. Increase or remove: ${list}.`;
}
