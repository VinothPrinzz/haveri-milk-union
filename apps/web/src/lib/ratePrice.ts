// apps/web/src/lib/ratePrice.ts
// ════════════════════════════════════════════════════════════════════
// Display mirror of apps/api/src/lib/rate-price.ts. The SERVER is the
// source of truth for what a customer is billed; this exists so the
// admin panel shows the same number the server will charge.
// KEEP IN SYNC with the api and mobile copies.
//
// Rule: a 'Credit Inst-MRP' customer (government institution) pays MRP
// on MILK-category products; everything else bills at the ordinary
// dealer price, unchanged.
//
// Non-milk needs no special case — the rate chart holds the SAME number
// in every tier for those SKUs, and it already equals base × (1 + gst).
// Only liquid milk carries a real MRP premium (HTM 1000ML: 44.65 vs 47.00).
//
// mrp is GROSS (GST-inclusive) but this returns a NET unit price, so GST
// is divided back out. Every Milk-category SKU is 0% GST today, making
// that an identity; it exists so a GST-bearing SKU filed under Milk in
// future can't be charged GST twice.
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

/** NET (pre-GST) unit price for this customer's rate category. */
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
