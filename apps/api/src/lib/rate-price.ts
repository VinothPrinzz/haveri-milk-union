// apps/api/src/lib/rate-price.ts
// ════════════════════════════════════════════════════════════════════
// Single backend source of truth for "what unit price does THIS dealer
// pay for THIS product?".
//
// ── Background: how the price columns relate ────────────────────────
// The client's rate chart (migration 0027) loads five numbers per SKU:
//
//   base_price               ← RETAIL-DEALER *Basic* Rate  (pre-GST, NET)
//   retail_dealer_price      ← RETAIL-DEALER Net Rate      (GST-incl, GROSS)
//   credit_inst_mrp_price    ← CREDIT INSTITUTION rate     (GROSS)
//   credit_inst_dealer_price ← CREDIT INSTITUTIONS rate    (GROSS)
//   parlour_dealer_price     ← PARLOUR-DEALER rate         (GROSS)
//
// products.mrp is populated FROM credit_inst_mrp_price (0027 line 414:
// `mrp = GREATEST(p.mrp, rc.ci_mrp)` — "the canonical MRP, the
// highest/consumer-facing rate"), so for rate-chart SKUs mrp IS the
// credit-institution rate.
//
// Two facts drive everything below:
//
//   1. For NON-MILK products every tier holds the SAME number, and it
//      equals base_price × (1 + gst).  e.g. 100GM BUTTER COOKIES:
//      basic 26.838, and all four tiers 28.18 = 26.838 × 1.05.
//      Since every order path already charges base_price and adds GST
//      on top, non-milk lines ALREADY bill the correct tier price for
//      every rate category. There is nothing to change for them.
//
//   2. For LIQUID MILK (0% GST) the credit-institution rate is genuinely
//      higher than the dealer rate — that gap IS this module's reason to
//      exist. e.g. HTM 1000ML: dealers 44.65, MRP 47.00.
//
// ── The rule ────────────────────────────────────────────────────────
// A 'Credit Inst-MRP' customer pays MRP on MILK-category products and
// the ordinary dealer price on everything else. Every other rate
// category is untouched.
//
// ── Why we divide by (1 + gst) ──────────────────────────────────────
// order_items.unit_price is a NET (pre-GST) figure — callers multiply
// by quantity and then add GST on top. mrp is GROSS. Feeding a gross
// number into that pipeline would charge GST twice.
//
// Today every product in the Milk category is 0% GST (9 SKUs, verified
// against production), so the division is an identity and this is pure
// belt-and-braces. It earns its keep the day a GST-bearing SKU is filed
// under Milk — chocolates, rusk, milkshakes and paneer each sit in their
// OWN category now, but an older seed had them under Milk, so the
// taxonomy has moved before and can move again.
//
// Mirrored for display by apps/web/src/lib/ratePrice.ts and
// apps/mobile/src/lib/ratePrice.ts — keep the three in sync.
// ════════════════════════════════════════════════════════════════════

/** dealers.rate_category / customer_type value that pays MRP on milk. */
export const CREDIT_INST_MRP = "Credit Inst-MRP";

/**
 * Product codes carrying a FIXED scheme price that no rate category may
 * override. The union subsidy SKU (PD0191S, migration 0056) is a
 * Milk-category product sold at a set half price — without this guard a
 * Credit Inst-MRP dealer would be billed its MRP (₹23.50) instead of the
 * scheme rate (₹22.33). Mirrors MIN_QTY_EXEMPT_CODES in min-order-qty.ts.
 */
export const SCHEME_PRICED_CODES = ["PD0191S"] as const;

function isSchemePriced(code: string | null | undefined): boolean {
  return (SCHEME_PRICED_CODES as readonly string[]).includes(
    String(code ?? "").trim()
  );
}

/**
 * The category the MRP rule applies to. Deliberately ONLY "milk" — the
 * wider milk-curd stock bucket (curd/lassi/buttermilk) is NOT included,
 * those bill at the dealer price like every other product.
 */
export function isMilkCategory(categoryName: string | null | undefined): boolean {
  return String(categoryName ?? "").trim().toLowerCase() === "milk";
}

/** True when this dealer buys milk at MRP. */
export function isCreditInstMrp(rateCategory: string | null | undefined): boolean {
  return String(rateCategory ?? "").trim() === CREDIT_INST_MRP;
}

const num = (v: number | string | null | undefined): number => {
  const n = typeof v === "string" ? parseFloat(v) : v ?? NaN;
  return Number.isFinite(n) ? (n as number) : NaN;
};

export interface PricedProduct {
  /** products.base_price — NET, pre-GST. The default for every tier. */
  basePrice: number | string;
  /** products.mrp — GROSS, GST-inclusive. May be null. */
  mrp?: number | string | null;
  /** products.gst_percent */
  gstPercent: number | string;
  /** categories.name — drives the milk test. */
  categoryName?: string | null;
  /** products.code — scheme-priced SKUs are never repriced. */
  code?: string | null;
}

/**
 * NET (pre-GST) unit price to store in order_items.unit_price.
 *
 * Callers keep their existing maths untouched:
 *   subtotal = unitPrice × qty;  gst = subtotal × pct;  total = sub + gst
 *
 * Returns base_price for every case except a Credit Inst-MRP dealer
 * buying a milk-category product with a real MRP above the dealer rate.
 */
export function resolveUnitPrice(
  product: PricedProduct,
  rateCategory: string | null | undefined
): number {
  const basePrice = num(product.basePrice);
  const safeBase = Number.isFinite(basePrice) ? basePrice : 0;

  if (!isCreditInstMrp(rateCategory)) return safeBase;
  if (!isMilkCategory(product.categoryName)) return safeBase;
  // A fixed-price scheme line keeps its scheme rate for every dealer.
  if (isSchemePriced(product.code)) return safeBase;

  const gross = num(product.mrp);
  if (!Number.isFinite(gross) || gross <= 0) return safeBase;

  const gstPct = num(product.gstPercent);
  const net = gross / (1 + (Number.isFinite(gstPct) ? gstPct : 0) / 100);

  // Never bill an institution BELOW the dealer rate. This also makes the
  // GST-bearing members of the Milk category (chocolates, rusk) a no-op:
  // their mrp is exactly base × (1+gst), so `net` lands on base_price and
  // floating-point noise can only push it a hair under.
  return net > safeBase ? net : safeBase;
}
