// src/lib/minOrderQty.ts
//
// Order-level minimum for the restricted category (Milk).
//
// Business rule (replaces the old per-line "≥6 units" rule): within a single
// order the TOTAL milk must be at least 12 litres, applying only when milk is
// in the order ("at least 12" is inclusive). Curd has NO minimum.
//
// Measure-matched: the Milk category also holds gram-measured items (milk
// chocolates, paneer). Only volume-measured milk counts toward the litre
// minimum (ml→L).
//
// Mirrors apps/api/src/lib/min-order-qty.ts (the server source of truth); this
// is the matching client guard so the operator can't submit an order the
// backend will reject.

/** Per-category order minimums, in base units (litres for milk). */
export const CATEGORY_MIN = {
  milk: { min: 12, unit: "L" },
} as const;

export type RestrictedCategory = keyof typeof CATEGORY_MIN;

const RESTRICTED = new Set<string>(["milk"]);

/** True when a product's category is subject to the order minimum. */
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
}

export interface CategoryShortfall {
  category: RestrictedCategory;
  total: number;
  min: number;
  unit: string;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Restricted categories present in the lines whose L total is below the minimum. */
export function findCategoryMinShortfalls(lines: MinLine[]): CategoryShortfall[] {
  let milkLitres = 0;
  for (const l of lines) {
    if (!(l.quantity > 0)) continue;
    const cat = (l.categoryName ?? "").trim().toLowerCase();
    const m = unitMeasure(l.unit, l.packSize, l.name);
    if (cat === "milk") milkLitres += l.quantity * m.litres;
  }
  const out: CategoryShortfall[] = [];
  const milk = round3(milkLitres);
  if (milk > 0 && milk < CATEGORY_MIN.milk.min) {
    out.push({ category: "milk", total: milk, min: CATEGORY_MIN.milk.min, unit: CATEGORY_MIN.milk.unit });
  }
  return out;
}

/** Friendly, list-y message naming each category that is below its minimum. */
export function categoryMinMessage(shortfalls: CategoryShortfall[]): string {
  return (
    shortfalls
      .map(
        (s) =>
          `Milk order must total at least ${s.min} ${s.unit} ` +
          `(currently ${s.total.toFixed(2)} ${s.unit})`,
      )
      .join("; ") + "."
  );
}

/** Short reminder of the rule, for helper text / tooltips. */
export const MIN_ORDER_RULE_TEXT =
  "Milk orders must total at least 12 L.";
