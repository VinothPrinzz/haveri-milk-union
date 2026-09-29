// apps/api/src/lib/min-order-qty.ts
// ═══════════════════════════════════════════════════════════════════════
// Order-level minimum for the restricted bucket (Milk + Curd).
//
// Business rule (2026-09-07 — replaces the milk-only "≥12 L" rule, which
// itself replaced a per-line "≥6 units" rule):
//
//   The dealer's FIRST live order on a given (route, delivery date) must
//   carry at least 12 of MILK + CURD combined, counting litres and
//   kilograms as one number (10 L milk + 3 kg curd = 13, which passes).
//
//   • The bucket is milk AND curd together, so a curd-only order is now
//     restricted too — it must reach 12 kg on its own.
//   • An order holding neither milk nor curd is unrestricted (a ghee-only
//     order never trips this).
//   • "At least 12" is inclusive; exactly 12 passes.
//
// ── Only the FIRST order per route + delivery date ─────────────────────
// The 12 floor exists to make the run worth dispatching, and the van
// serves a route once per delivery date. Once the dealer already has a
// live order on that route/date that ITSELF cleared 12, the run is
// already earned: every further order for the same route and date is
// exempt, however small. See hasQualifyingSiblingOrder below.
//
// The sibling must itself reach 12, not merely exist. Two weaker readings
// both open a hole:
//   • "any sibling" — a 2 L draft plus a 2 L order would leave the route
//     carrying 4 L, because the draft is cancelled as superseded the
//     moment the second order is placed (lib/supersede-orders.ts).
//   • "any live sibling" — modifying the qualifying order back down to
//     2 L would then be waved through by the small order it had itself
//     licensed. Requiring the sibling to clear 12 keeps exactly one
//     order on the hook for the route.
//
// Measure-matched conversion: pack sizes normalise to litres (ml→L) or
// kilograms (g→kg), then the two are added. Milk SKUs are all volume and
// curd SKUs are all weight, so in practice this is "litres of milk plus
// kilos of curd".
//
// Single source of truth for the rule on the API side; every
// order-placement / draft-confirm endpoint calls into it so the guarantee
// holds no matter which surface (dealer app, admin panel, call desk) the
// order came from. Mirrored in apps/worker/src/jobs/auto-confirm-drafts.ts
// (its own package), apps/web/src/lib/minOrderQty.ts and
// apps/mobile/src/lib/minOrderQty.ts (client-side guards).
// ═══════════════════════════════════════════════════════════════════════

import { pgClient } from "./db.js";

/** The combined milk + curd order minimum, in L (volume) + kg (weight). */
export const ORDER_MIN = { min: 12, unit: "L/kg" } as const;

/**
 * Category names (compared case-insensitively) that count toward the
 * minimum. Kept in sync by hand with the `lower(c.name) IN ('milk','curd')`
 * literals in the queries below — the Supabase transaction pooler crashes
 * on array bound params, so the list cannot be passed as `${...}::text[]`.
 */
export const MIN_QTY_CATEGORY_NAMES = ["milk", "curd"] as const;

/**
 * Subsidy milk is EXEMPT from the minimum: it is a half-price scheme line
 * placed on the admin's behalf, so it must neither count toward nor trigger
 * the 12 L/kg floor (a subsidy-milk-only standing indent still auto-confirms).
 *
 * Matched two ways in the SQL below, because one is not enough:
 *   • by code, for the live SKU (PD0191S, migration 0056);
 *   • by name ILIKE '%subsid%', for the two older 'HTM 1000ML SUBSIDY' rows.
 *     Those are soft-deleted today, but they sit under code P06 — which is
 *     ALSO a live goodlife SKU ("G/L UHT SLIM 500ML(BRIK) 24 PACK") — so
 *     they can only be excluded by name. Matching P06 on code would exempt a
 *     real product.
 * No non-subsidy product carries "subsid" in its name.
 */
export const MIN_QTY_EXEMPT_CODES = ["PD0191S"] as const;

/** Products whose NAME marks them as scheme/subsidy milk are exempt too. */
export const MIN_QTY_EXEMPT_NAME_PATTERN = /subsid/i;

/** True when this product is subsidy milk and so never counts toward the floor. */
export function isMinQtyExemptProduct(
  product: { code?: string | null; name?: string | null } | null | undefined
): boolean {
  const code = String(product?.code ?? "").trim();
  if ((MIN_QTY_EXEMPT_CODES as readonly string[]).includes(code)) return true;
  return MIN_QTY_EXEMPT_NAME_PATTERN.test(String(product?.name ?? ""));
}

/**
 * Rate categories EXEMPT from the minimum. 'Credit Inst-MRP' customers
 * are government institutions: supply is compulsory however small the
 * indent, so the 12 floor must not block them. Note this is narrower than
 * isCreditInstitutionType() — 'Credit Inst-Dealer' still carries it.
 */
export const MIN_QTY_EXEMPT_RATE_CATEGORIES = ["Credit Inst-MRP"] as const;

/**
 * Order statuses that count as a LIVE order on the route for the day —
 * the complement of the draft/cancelled set that lib/supersede-orders.ts
 * is allowed to cancel. Written as a literal in the SQL below for the
 * same pooler reason as MIN_QTY_CATEGORY_NAMES.
 */
export const LIVE_ORDER_STATUSES = [
  "confirmed",
  "dispatched",
  "delivered",
  "pending",
] as const;

/** True when this dealer's rate category is exempt from the minimum. */
export function isMinQtyExemptRateCategory(
  rateCategory: string | null | undefined
): boolean {
  return (MIN_QTY_EXEMPT_RATE_CATEGORIES as readonly string[]).includes(
    String(rateCategory ?? "").trim()
  );
}

/**
 * Look up a dealer's rate category and say whether they skip the minimum.
 * Call sites hold a dealerId far more often than a rate category, so this
 * keeps them to a one-line change. Unknown/missing dealer → not exempt.
 */
export async function isDealerExemptFromMinQty(
  dealerId: string | null | undefined
): Promise<boolean> {
  if (!dealerId) return false;
  const [row] = await pgClient`
    SELECT rate_category::text AS rate_category
      FROM dealers
     WHERE id = ${dealerId} AND deleted_at IS NULL
     LIMIT 1
  `;
  return isMinQtyExemptRateCategory(row?.rate_category);
}

export interface MinQtyViolation {
  total: number; // ordered milk + curd total (L + kg), rounded to 3dp
  min: number;   // required minimum
  unit: string;  // "L/kg"
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
  quantity: number;
  unit: string | null;
  packSize: number | string | null;
  name?: string | null;
}

/**
 * Combined milk + curd size of a set of lines: litres and kilograms added
 * into one number. Callers must have already filtered the lines down to
 * the restricted categories and dropped the exempt SKUs.
 */
function combinedTotal(lines: MeasuredLine[]): number {
  let total = 0;
  for (const l of lines) {
    if (!(l.quantity > 0)) continue;
    const m = unitMeasure(l.unit, l.packSize, l.name);
    total += l.quantity * (m.litres + m.kg);
  }
  return round3(total);
}

/** The shortfall, if the milk + curd total is present but under the minimum. */
function computeShortfall(lines: MeasuredLine[]): MinQtyViolation[] {
  const total = combinedTotal(lines);
  if (total > 0 && total < ORDER_MIN.min) {
    return [{ total, min: ORDER_MIN.min, unit: ORDER_MIN.unit }];
  }
  return [];
}

/** Human-readable message for a shortfall. No em dashes: the web renders this. */
export function minQtyErrorMessage(violations: MinQtyViolation[]): string {
  return violations
    .map(
      (v) =>
        `Milk and curd must total at least ${v.min} ${v.unit} ` +
        `(currently ${v.total.toFixed(2)} ${v.unit}).`,
    )
    .join(" ");
}

/**
 * Where an order sits, for the "first order on this route today" test.
 * Omit deliveryDate to mean today IST (the default for a cart order).
 */
export interface MinQtySiblingContext {
  dealerId?: string | null;
  routeId?: string | null;
  /** YYYY-MM-DD. Null/undefined → today in IST. */
  deliveryDate?: string | null;
  /** The order being placed or edited; never its own sibling. */
  excludeOrderId?: string | null;
}

/**
 * True when this dealer already has a LIVE order on the same route and
 * delivery date whose own milk + curd total reaches the minimum — i.e.
 * the order about to be placed is not the first one for that run, so the
 * floor no longer applies to it.
 *
 * Returns false when there is no route or dealer to key on: an order we
 * cannot place on a run has to clear the bar by itself.
 *
 * Note the category / status / exempt-code lists are inlined as SQL
 * literals rather than bound arrays; see MIN_QTY_CATEGORY_NAMES.
 */
export async function hasQualifyingSiblingOrder(
  ctx: MinQtySiblingContext
): Promise<boolean> {
  if (!ctx.dealerId || !ctx.routeId) return false;

  const rows = (await pgClient`
    SELECT o.id::text     AS order_id,
           oi.quantity    AS quantity,
           p.unit         AS unit,
           p.pack_size    AS pack_size,
           p.name         AS name
      FROM orders o
      JOIN dealers d      ON d.id = o.dealer_id
      JOIN order_items oi ON oi.order_id = o.id
      JOIN products p     ON p.id = oi.product_id
      JOIN categories c   ON c.id = p.category_id
     WHERE o.dealer_id = ${ctx.dealerId}
       AND o.delivery_date = COALESCE(
             ${ctx.deliveryDate ?? null}::date,
             (now() AT TIME ZONE 'Asia/Kolkata')::date
           )
       -- Route the order was stamped with at create/confirm, falling back
       -- to the dealer's current route for the handful of legacy rows that
       -- carry no route_id.
       AND COALESCE(o.route_id, d.route_id) IS NOT DISTINCT FROM ${ctx.routeId}::uuid
       -- Live only. A draft or payment_required sibling is exactly what
       -- the supersede rule cancels when this order lands, so it can never
       -- license a small order.
       AND o.status IN ('confirmed', 'dispatched', 'delivered', 'pending')
       AND (${ctx.excludeOrderId ?? null}::uuid IS NULL
            OR o.id <> ${ctx.excludeOrderId ?? null}::uuid)
       AND oi.quantity > 0
       AND lower(c.name) IN ('milk', 'curd')
       -- Subsidy milk never counts toward nor triggers the minimum:
       -- the live SKU by code, plus any other scheme SKU by name (two
       -- older 'HTM 1000ML SUBSIDY' rows exist, both under code P06,
       -- which is ALSO a live goodlife SKU and so must not be matched
       -- on code). See MIN_QTY_EXEMPT_CODES.
       AND COALESCE(p.code, '') <> 'PD0191S'
       AND p.name NOT ILIKE '%subsid%'
  `) as Array<{
    order_id: string;
    quantity: number;
    unit: string | null;
    pack_size: string | null;
    name: string;
  }>;

  // Group the lines back into their orders: the exemption is granted by a
  // single sibling that cleared 12 on its own, not by several that add up.
  const byOrder = new Map<string, MeasuredLine[]>();
  for (const r of rows) {
    const list = byOrder.get(r.order_id) ?? [];
    list.push({
      quantity: Number(r.quantity),
      unit: r.unit,
      packSize: r.pack_size,
      name: r.name,
    });
    byOrder.set(r.order_id, list);
  }

  for (const lines of byOrder.values()) {
    if (combinedTotal(lines) >= ORDER_MIN.min) return true;
  }
  return false;
}

/**
 * Aggregate check for a raw {productId, quantity} item list (order
 * placement / modify / standing-indent paths). Fetches each product's
 * category + unit so quantities can be normalised to L/kg.
 *
 * `ctx.dealerId` also drives the Credit Inst-MRP exemption. Pass the route
 * and delivery date too wherever the items are becoming a real order, so a
 * second order on an already-served run skips the floor; omit them for a
 * standing-indent TEMPLATE, which always produces the day's first order.
 */
export async function findMinQtyViolations(
  items: Array<{ productId: string; quantity: number }>,
  ctx: MinQtySiblingContext = {},
): Promise<MinQtyViolation[]> {
  const positive = items.filter((i) => i.quantity > 0);
  if (positive.length === 0) return [];

  if (await isDealerExemptFromMinQty(ctx.dealerId)) return [];
  if (await hasQualifyingSiblingOrder(ctx)) return [];

  const ids = positive.map((i) => i.productId);
  const rows = (await pgClient`
    SELECT p.id::text AS id, p.name AS name, p.unit AS unit, p.pack_size AS pack_size
      FROM products p
      JOIN categories c ON c.id = p.category_id
     WHERE p.id = ANY(${ids}::uuid[])
       AND lower(c.name) IN ('milk', 'curd')
       -- Subsidy milk never counts toward nor triggers the minimum:
       -- the live SKU by code, plus any other scheme SKU by name (two
       -- older 'HTM 1000ML SUBSIDY' rows exist, both under code P06,
       -- which is ALSO a live goodlife SKU and so must not be matched
       -- on code). See MIN_QTY_EXEMPT_CODES.
       AND COALESCE(p.code, '') <> 'PD0191S'
       AND p.name NOT ILIKE '%subsid%'
  `) as Array<{ id: string; name: string; unit: string | null; pack_size: string | null }>;

  const meta = new Map(rows.map((r) => [r.id, r]));
  const lines: MeasuredLine[] = [];
  for (const i of positive) {
    const m = meta.get(i.productId);
    if (m) lines.push({ quantity: i.quantity, unit: m.unit, packSize: m.pack_size, name: m.name });
  }
  return computeShortfall(lines);
}

/**
 * Same aggregate check against an order's already-persisted line items.
 * Used by the draft-confirm endpoints, which only hold an orderId by the
 * time the order is being placed. The order knows its own dealer, route
 * and delivery date, so both exemptions are resolved here rather than
 * pushed onto every caller.
 */
export async function findOrderMinQtyViolations(
  orderId: string,
): Promise<MinQtyViolation[]> {
  const [owner] = await pgClient`
    SELECT d.rate_category::text                  AS rate_category,
           o.dealer_id::text                      AS dealer_id,
           COALESCE(o.route_id, d.route_id)::text AS route_id,
           o.delivery_date::text                  AS delivery_date
      FROM orders o
      JOIN dealers d ON d.id = o.dealer_id
     WHERE o.id = ${orderId}::uuid
     LIMIT 1
  `;
  if (isMinQtyExemptRateCategory(owner?.rate_category)) return [];

  // Not the first order on this route for the day → no floor. The order
  // being confirmed is excluded so it can never license itself.
  if (
    await hasQualifyingSiblingOrder({
      dealerId: owner?.dealer_id ?? null,
      routeId: owner?.route_id ?? null,
      deliveryDate: owner?.delivery_date ?? null,
      excludeOrderId: orderId,
    })
  ) {
    return [];
  }

  const rows = (await pgClient`
    SELECT oi.quantity AS quantity,
           p.unit AS unit, p.pack_size AS pack_size, p.name AS name
      FROM order_items oi
      JOIN products p   ON p.id = oi.product_id
      JOIN categories c ON c.id = p.category_id
     WHERE oi.order_id = ${orderId}::uuid
       AND oi.quantity > 0
       AND lower(c.name) IN ('milk', 'curd')
       -- Subsidy milk never counts toward nor triggers the minimum:
       -- the live SKU by code, plus any other scheme SKU by name (two
       -- older 'HTM 1000ML SUBSIDY' rows exist, both under code P06,
       -- which is ALSO a live goodlife SKU and so must not be matched
       -- on code). See MIN_QTY_EXEMPT_CODES.
       AND COALESCE(p.code, '') <> 'PD0191S'
       AND p.name NOT ILIKE '%subsid%'
  `) as Array<{ quantity: number; unit: string | null; pack_size: string | null; name: string }>;

  return computeShortfall(
    rows.map((r) => ({
      quantity: Number(r.quantity),
      unit: r.unit,
      packSize: r.pack_size,
      name: r.name,
    })),
  );
}

/**
 * Does the minimum apply to an order the dealer is about to place on this
 * route and date? Backs the client-side guards (web Record Indents / Dealer
 * Indents, mobile cart), which must not block a second order the server
 * would happily accept.
 */
export async function getMinQtyRequirement(ctx: MinQtySiblingContext): Promise<{
  applies: boolean;
  min: number;
  unit: string;
  reason: "required" | "exempt_rate_category" | "route_already_served";
}> {
  if (await isDealerExemptFromMinQty(ctx.dealerId)) {
    return { applies: false, min: ORDER_MIN.min, unit: ORDER_MIN.unit, reason: "exempt_rate_category" };
  }
  if (await hasQualifyingSiblingOrder(ctx)) {
    return { applies: false, min: ORDER_MIN.min, unit: ORDER_MIN.unit, reason: "route_already_served" };
  }
  return { applies: true, min: ORDER_MIN.min, unit: ORDER_MIN.unit, reason: "required" };
}
