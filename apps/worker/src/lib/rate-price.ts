// apps/worker/src/lib/rate-price.ts
// ════════════════════════════════════════════════════════════════════
// Mirror of apps/api/src/lib/rate-price.ts — the worker is its own
// package and cannot import from the API. KEEP THE TWO IN SYNC: the
// nightly materialize + warning-time auto-confirm must price a standing
// indent exactly as the API would have priced the same order.
//
// Rule: a 'Credit Inst-MRP' customer (government institution) pays MRP
// on MILK-category products; everything else bills at the ordinary
// dealer price, unchanged.
//
// Non-milk needs no special case: the rate chart holds the SAME number
// in every tier for those SKUs, and it already equals
// base_price × (1 + gst) — which is what adding GST to base_price
// produces today. Only liquid milk has a genuine MRP premium
// (e.g. HTM 1000ML: dealers 44.65, MRP 47.00).
//
// products.mrp is GROSS (GST-inclusive) while unit_price is NET, so we
// divide GST back out. Every Milk-category SKU is 0% GST today, so that
// division is an identity — it exists to stay correct if a GST-bearing
// product is ever filed under Milk.
// ════════════════════════════════════════════════════════════════════

export const CREDIT_INST_MRP = "Credit Inst-MRP";

/**
 * Fixed scheme prices no rate category may override — the union subsidy
 * SKU (PD0191S) is a Milk product sold at a set half price. Mirrors
 * SCHEME_PRICED_CODES in apps/api/src/lib/rate-price.ts.
 */
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
  mrp?: number | string | null;
  gstPercent: number | string;
  categoryName?: string | null;
  /** products.code — scheme-priced SKUs are never repriced. */
  code?: string | null;
}

/** NET (pre-GST) unit price for this dealer's rate category. */
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
