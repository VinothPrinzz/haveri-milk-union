// apps/mobile/src/lib/ratePrice.ts
// ════════════════════════════════════════════════════════════════════
// Display mirror of apps/api/src/lib/rate-price.ts. The SERVER decides
// what a dealer is billed; this exists so the app shows the same number
// the server will charge. KEEP IN SYNC with the api and web copies.
//
// Rule: a 'Credit Inst-MRP' dealer (government institution) pays MRP on
// MILK-category products; everything else bills at the ordinary dealer
// price, unchanged.
//
// Non-milk needs no special case — the rate chart holds the SAME number
// in every tier for those SKUs, already equal to base × (1 + gst). Only
// liquid milk carries a real MRP premium (HTM 1000ML: 44.65 vs 47.00).
//
// NOTE ON THE SUBSIDY LINE: the union subsidy SKU is a Milk product with
// a FIXED half-price. Callers pass its scheme price straight through
// (see HomeScreen's cart seeding), AND the resolver refuses to reprice it
// by code — belt and braces, because getting this wrong bills an
// institution ₹23.50 for milk the union sells them at ₹22.33.
// ════════════════════════════════════════════════════════════════════

export const CREDIT_INST_MRP = "Credit Inst-MRP";

/** Fixed scheme prices no rate category may override. Mirrors the API. */
export const SCHEME_PRICED_CODES = ["PD0191S"] as const;

function isSchemePriced(code: string | null | undefined): boolean {
  return (SCHEME_PRICED_CODES as readonly string[]).includes(
    String(code ?? "").trim()
  );
}

export function isMilkCategory(categoryName: string | null | undefined): boolean {
  return String(categoryName ?? "").trim().toLowerCase() === "milk";
}

export function isCreditInstMrp(rateCategory: string | null | undefined): boolean {
  return String(rateCategory ?? "").trim() === CREDIT_INST_MRP;
}

const num = (v: number | string | null | undefined): number => {
  const n = typeof v === "string" ? parseFloat(v) : v ?? NaN;
  return Number.isFinite(n) ? (n as number) : NaN;
};

export interface PricedProduct {
  basePrice: number | string;
  /** GROSS, GST-inclusive. */
  mrp?: number | string | null;
  /** GROSS, GST-inclusive — what the dealer app shows by default. */
  dealerPrice?: number | string | null;
  gstPercent: number | string;
  categoryName?: string | null;
  /** products.code — scheme-priced SKUs are never repriced. */
  code?: string | null;
}

/**
 * NET (pre-GST) unit price — the basis for cart line maths, which then
 * adds GST on top exactly like the server does.
 */
export function resolveUnitPrice(
  product: PricedProduct,
  rateCategory: string | null | undefined
): number {
  const basePrice = num(product.basePrice);
  const safeBase = Number.isFinite(basePrice) ? basePrice : 0;

  if (!isCreditInstMrp(rateCategory)) return safeBase;
  if (!isMilkCategory(product.categoryName)) return safeBase;
  if (isSchemePriced(product.code)) return safeBase;

  const gross = num(product.mrp);
  if (!Number.isFinite(gross) || gross <= 0) return safeBase;

  const gstPct = num(product.gstPercent);
  const net = gross / (1 + (Number.isFinite(gstPct) ? gstPct : 0) / 100);

  // Never bill an institution below the dealer rate.
  return net > safeBase ? net : safeBase;
}

/**
 * GROSS (GST-inclusive) price to PRINT on a product card. Dealers see the
 * price they actually pay, so this is the resolved unit price with GST
 * added back on. Falls back to the catalog's gross dealer price for
 * ordinary rate categories, preserving today's display exactly.
 */
export function resolveDisplayPrice(
  product: PricedProduct,
  rateCategory: string | null | undefined
): number {
  if (isCreditInstMrp(rateCategory) && isMilkCategory(product.categoryName)) {
    const net = resolveUnitPrice(product, rateCategory);
    const gstPct = num(product.gstPercent);
    return net * (1 + (Number.isFinite(gstPct) ? gstPct : 0) / 100);
  }
  const dealer = num(product.dealerPrice);
  if (Number.isFinite(dealer) && dealer > 0) return dealer;
  const mrp = num(product.mrp);
  if (Number.isFinite(mrp) && mrp > 0) return mrp;
  const base = num(product.basePrice);
  return Number.isFinite(base) ? base : 0;
}
