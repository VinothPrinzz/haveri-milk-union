// apps/api/src/lib/min-order-qty.ts
// ═══════════════════════════════════════════════════════════════════════
// Order-level minimum for restricted categories (Milk & Curd).
//
// Business rule (replaces the old per-line "≥6 units" rule): within a SINGLE
// order the TOTAL milk must be at least 12 litres and the TOTAL curd at least
// 12 kilograms. Each minimum applies only when the order actually contains
// that category — an order with only milk needs no curd, and an order with
// neither is unrestricted. "At least 12" is inclusive (exactly 12 passes).
//
// Measure-matched conversion: the Milk category also holds gram-measured items
// (milk chocolates, paneer, rusk) and the Curd category holds ml-measured
// lassi/buttermilk. You can't add grams to a litre total, so ONLY
// volume-measured milk counts toward the litre minimum and ONLY
// weight-measured curd toward the kg minimum (ml→L, g→kg).
//
// Single source of truth for the rule on the API side; every order-placement
// / draft-confirm endpoint calls into it so the guarantee holds no matter
// which surface (dealer app, admin panel, call desk) the order came from.
// ═══════════════════════════════════════════════════════════════════════

import { pgClient } from "./db.js";

/** Per-category order minimums, in base units (litres for milk, kg for curd). */
export const CATEGORY_MIN = {
  milk: { min: 12, unit: "L" },
  curd: { min: 12, unit: "kg" },
} as const;

/** Category names (compared case-insensitively) the minimum applies to. */
export const MIN_QTY_CATEGORY_NAMES = ["milk", "curd"] as const;

export type RestrictedCategory = keyof typeof CATEGORY_MIN;

export interface CategoryMinViolation {
  category: RestrictedCategory;
  total: number; // ordered total in base units (L / kg), rounded to 3dp
  min: number;   // required minimum
  unit: string;  // "L" | "kg"
}

// ── Unit → physical measure (litres for volume, kilograms for weight) ──
const SIZE_TOKEN = /(\d+(?:\.\d+)?)\s*(kg|kilogram|ltr|litre|liter|ml|gm|g|l)\b/i;

interface Measure { litres: number; kg: number; }

function parseMeasure(text: string): Measure | null {
  const m = text.match(SIZE_TOKEN);
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

/** Litres / kilograms contained in ONE unit — unit text, then name, then pack_size. */
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

const round3 = (n: number) => Math.round(n * 1000) / 1000;

interface MeasuredLine {
  category: string;
  quantity: number;
  unit: string | null;
  packSize: number | string | null;
  name?: string | null;
}

/** Restricted categories present in the order whose L/kg total is below the min. */
function computeShortfalls(lines: MeasuredLine[]): CategoryMinViolation[] {
  let milkLitres = 0;
  let curdKg = 0;
  for (const l of lines) {
    if (!(l.quantity > 0)) continue;
    const cat = (l.category ?? "").trim().toLowerCase();
    const m = unitMeasure(l.unit, l.packSize, l.name);
    // Milk is minimised in litres (volume), curd in kilograms (weight); each
    // counts only the lines whose unit actually measures that quantity.
    if (cat === "milk") milkLitres += l.quantity * m.litres;
    else if (cat === "curd") curdKg += l.quantity * m.kg;
  }
  const out: CategoryMinViolation[] = [];
  const milk = round3(milkLitres);
  if (milk > 0 && milk < CATEGORY_MIN.milk.min) {
    out.push({ category: "milk", total: milk, min: CATEGORY_MIN.milk.min, unit: CATEGORY_MIN.milk.unit });
  }
  const curd = round3(curdKg);
  if (curd > 0 && curd < CATEGORY_MIN.curd.min) {
    out.push({ category: "curd", total: curd, min: CATEGORY_MIN.curd.min, unit: CATEGORY_MIN.curd.unit });
  }
  return out;
}

/** Human-readable message naming each category that is below its minimum. */
export function minQtyErrorMessage(violations: CategoryMinViolation[]): string {
  return (
    violations
      .map(
        (v) =>
          `${v.category === "milk" ? "Milk" : "Curd"} order must total at least ` +
          `${v.min} ${v.unit} (currently ${v.total.toFixed(2)} ${v.unit})`,
      )
      .join("; ") + "."
  );
}

/**
 * Aggregate check for a raw {productId, quantity} item list (order placement /
 * modify / standing-indent paths). Fetches each product's category + unit so
 * quantities can be normalised to L/kg.
 */
export async function findMinQtyViolations(
  items: Array<{ productId: string; quantity: number }>,
): Promise<CategoryMinViolation[]> {
  const positive = items.filter((i) => i.quantity > 0);
  if (positive.length === 0) return [];

  const ids = positive.map((i) => i.productId);
  const rows = (await pgClient`
    SELECT p.id::text AS id, p.name AS name, p.unit AS unit, p.pack_size AS pack_size,
           c.name AS category
      FROM products p
      JOIN categories c ON c.id = p.category_id
     WHERE p.id = ANY(${ids}::uuid[])
       AND lower(c.name) = ANY(${MIN_QTY_CATEGORY_NAMES as unknown as string[]}::text[])
  `) as Array<{ id: string; name: string; unit: string | null; pack_size: string | null; category: string }>;

  const meta = new Map(rows.map((r) => [r.id, r]));
  const lines: MeasuredLine[] = [];
  for (const i of positive) {
    const m = meta.get(i.productId);
    if (m) lines.push({ category: m.category, quantity: i.quantity, unit: m.unit, packSize: m.pack_size, name: m.name });
  }
  return computeShortfalls(lines);
}

/**
 * Same aggregate check against an order's already-persisted line items. Used
 * by the draft-confirm endpoints, which only hold an orderId by the time the
 * order is being placed.
 */
export async function findOrderMinQtyViolations(
  orderId: string,
): Promise<CategoryMinViolation[]> {
  const rows = (await pgClient`
    SELECT c.name AS category, oi.quantity AS quantity,
           p.unit AS unit, p.pack_size AS pack_size, p.name AS name
      FROM order_items oi
      JOIN products p   ON p.id = oi.product_id
      JOIN categories c ON c.id = p.category_id
     WHERE oi.order_id = ${orderId}::uuid
       AND oi.quantity > 0
       AND lower(c.name) = ANY(${MIN_QTY_CATEGORY_NAMES as unknown as string[]}::text[])
  `) as Array<{ category: string; quantity: number; unit: string | null; pack_size: string | null; name: string }>;

  return computeShortfalls(
    rows.map((r) => ({
      category: r.category,
      quantity: Number(r.quantity),
      unit: r.unit,
      packSize: r.pack_size,
      name: r.name,
    })),
  );
}
