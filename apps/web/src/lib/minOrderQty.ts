// src/lib/minOrderQty.ts
//
// Order-level minimum for milk + curd.
//
// Business rule: the FIRST indent on a route each day must carry at least
// 12 L/kg of milk and curd combined (litres of milk + kilograms of curd,
// "at least 12" is inclusive). Later indents on the same route and date have
// no minimum; whether this indent is the first is the server's call, read
// from GET /orders/min-qty-status and passed in here as `exempt`.
//
// Measure-matched: the Milk category also holds gram-measured items (milk
// chocolates, paneer), so a line counts by its physical size (ml→L, g→kg).
// The subsidy SKU never counts.
//
// Mirrors apps/api/src/lib/min-order-qty.ts (the server source of truth); this
// is the matching client guard so the operator can't submit an order the
// backend will reject.

/** The order minimum, in litres + kilograms of milk and curd combined. */
export const ORDER_MIN = { min: 12, unit: "L/kg" } as const;

const RESTRICTED = new Set<string>(["milk", "curd"]);

/** True when a product's category counts toward the order minimum. */
export function isMinQtyCategory(categoryName?: string | null): boolean {
  return !!categoryName && RESTRICTED.has(categoryName.trim().toLowerCase());
}

// ── Unit → physical measure (litres for volume, kilograms for weight) ──
const SIZE_TOKEN = /(\d+(?:\.\d+)?)\s*(kg|kilogram|ltr|litre|liter|ml|gm|g|l)\b/i;

export interface Measure { litres: number; kg: number; }

function parseMeasure(text: string): Measure | null {
  const m = text.match(SIZE_TOKEN);
  if (!m) return null;
  const size = parseFloat(m[1]);
  switch (m[2].toLowerCase()) {
    case "ml":                                        return { litres: size / 1000, kg: 0 };
    case "l": case "ltr": case "litre": case "liter": return { litres: size, kg: 0 };
    case "g": case "gm":                              return { litres: 0, kg: size / 1000 };
    case "kg": case "kilogram":                       return { litres: 0, kg: size };
  }
  return null;
}

/** Litres / kilograms in ONE unit — unit text, then name, then packSize. */
export function unitMeasure(
  unit?: string | null,
  packSize?: number | string | null,
  name?: string | null,
): Measure {
  const fromUnit = parseMeasure((unit ?? "").toString());
  if (fromUnit) return fromUnit;
  const fromName = parseMeasure((name ?? "").toString());
  if (fromName) return fromName;
  const ps = typeof packSize === "string" ? parseFloat(packSize) : packSize ?? 0;
  if (ps && ps > 0) {
    const u = (unit ?? "").toString();
    if (/kg/i.test(u)) return { litres: 0, kg: ps };
    if (/ltr|litre|liter/i.test(u)) return { litres: ps, kg: 0 };
  }
  return { litres: 0, kg: 0 };
}

export interface MinLine {
  categoryName?: string | null;
  quantity: number;
  unit?: string | null;
  packSize?: number | string | null;
  name?: string | null;
  code?: string | null;
  /** Exempt from the minimum. Never counts. */
  exempt?: boolean;
}

export interface CategoryShortfall {
  total: number;
  min: number;
  unit: string;
}

// The subsidy HTM 1000ML SKU (migration 0056) never counts toward the minimum.
const EXEMPT_CODES = ["PD0191S"];

export function isMinQtyExemptProduct(p?: { code?: string | null; name?: string | null }): boolean {
  const code = String(p?.code ?? "").trim();
  if (EXEMPT_CODES.includes(code)) return true;
  return /subsid/i.test(String(p?.name ?? ""));
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Milk + curd in the lines, as litres + kilograms. */
function minQtyTotal(lines: MinLine[]): number {
  let total = 0;
  for (const l of lines) {
    if (!(l.quantity > 0)) continue;
    if (l.exempt || isMinQtyExemptProduct(l)) continue;
    if (!isMinQtyCategory(l.categoryName)) continue;
    const m = unitMeasure(l.unit, l.packSize, l.name);
    total += l.quantity * (m.litres + m.kg);
  }
  return round3(total);
}

/**
 * The shortfall, if the order carries milk/curd below the minimum. Pass
 * `exempt` when the minimum does not apply to this indent (the route already
 * has one today, or the dealer's rate category is exempt).
 */
export function findCategoryMinShortfalls(
  lines: MinLine[],
  opts?: { exempt?: boolean },
): CategoryShortfall[] {
  if (opts?.exempt) return [];
  const total = minQtyTotal(lines);
  return total > 0 && total < ORDER_MIN.min
    ? [{ total, min: ORDER_MIN.min, unit: ORDER_MIN.unit }]
    : [];
}

/** Friendly message for the shortfall. */
export function categoryMinMessage(shortfalls: CategoryShortfall[]): string {
  return shortfalls
    .map(
      (s) =>
        `Milk and curd must total at least ${s.min} ${s.unit} ` +
        `(currently ${s.total.toFixed(2)} ${s.unit}).`,
    )
    .join(" ");
}

/** Short reminder of the rule, for helper text / tooltips. */
export const MIN_ORDER_RULE_TEXT =
  "Milk and curd must total at least 12 L/kg on the first indent for a route each day. " +
  "Later indents on the same route and date have no minimum.";
