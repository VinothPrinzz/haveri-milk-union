// apps/api/src/lib/price-revisions.ts
// ════════════════════════════════════════════════════════════════════
// How a product's price changes, and the one place that change is logged.
//
// Staff set two numbers per product:
//
//   dealer_price  GROSS (GST inclusive). What the dealer app and the Price
//                 Chart show, and what base_price is derived from.
//   mrp           GROSS. What a Credit Inst-MRP customer pays on milk
//                 (see resolveUnitPrice in rate-price.ts).
//
// base_price, the NET Basic Price that every order line snapshots, is never
// typed by anyone: it is dealer_price / (1 + GST), to the paisa.
//
// Two screens change these numbers: Masters > Price Revisions and an edit on
// All Products. Both log through recordPriceRevision(), so the Price
// Revisions history is complete no matter where a price was changed.
//
// The Price Revisions page used to write the typed rate straight into
// base_price and leave dealer_price and mrp alone. The Price Chart and the
// dealer app kept showing the old price while orders billed the new one, and
// the next save on All Products re-derived base_price from the stale
// dealer_price and silently undid the revision.
// ════════════════════════════════════════════════════════════════════
import { pgClient } from "./db.js";
import { istToday } from "./ist-date.js";
import { repriceOpenDrafts } from "./reprice-drafts.js";

// Helper to derive base_price ("Basic Price", excluding GST) from the
// Dealer-Price (gross, inclusive of GST).
//
// TWO decimals, deliberately. Prices in this system are rupees and paise —
// a dealer is never billed, and never pays, a fraction of a paisa. The
// derivation used to keep three, which put e.g. 255.105 (267.86 / 1.05) in
// products.base_price and from there into order_items.unit_price. Nothing
// downstream could show that third decimal (line_total, gst_amount and
// grand_total all round to paise), but reports that group lines by the
// stored price split one SKU into two identical-looking rows the day the
// master was re-saved and the 2dp value became 3dp. Keep it at paise.
export function deriveBasePriceFromDealerPrice(dealerPrice: number, gstPercent: number): number {
  const safeGst = Math.max(0, gstPercent || 0);
  return Math.round((dealerPrice / (1 + safeGst / 100)) * 100) / 100;
}

/** A price as a whole number of paise, so "30", "30.00" and 30 compare equal. */
export function toPaise(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

const asNumeric = (v: number | string | null | undefined): string | null =>
  v == null ? null : String(v);

const rupees = (n: number) => `₹${n.toFixed(2)}`;

/** A rejected price revision line. Thrown inside the batch transaction, so it rolls the batch back. */
export class PriceRevisionError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "PriceRevisionError";
    this.statusCode = statusCode;
  }
}

/** The four numbers a price change can move, as read from / written to products. */
export interface PriceSnapshot {
  basePrice:   number | string;
  dealerPrice: number | string | null;
  mrp:         number | string | null;
  gstPercent:  number | string;
}

/**
 * True when any price moved by at least a paisa. A 3dp base_price that was
 * merely normalised to paise (102.038 -> 102.04) does not count.
 */
export function priceMoved(before: PriceSnapshot, after: PriceSnapshot): boolean {
  return (
    toPaise(before.basePrice)   !== toPaise(after.basePrice) ||
    toPaise(before.dealerPrice) !== toPaise(after.dealerPrice) ||
    toPaise(before.mrp)         !== toPaise(after.mrp) ||
    Number(before.gstPercent)   !== Number(after.gstPercent)
  );
}

/**
 * Logs one product's price change to price_revisions, inside the caller's
 * transaction so the log and the products UPDATE commit together.
 *
 * Returns false and writes nothing when no price moved (see priceMoved), so
 * re-saving an unchanged product never shows up as a phantom revision.
 */
export async function recordPriceRevision(
  tx: typeof pgClient,
  args: {
    productId: string;
    before:    PriceSnapshot;
    after:     PriceSnapshot;
    changedBy: string;
    source:    "price_revision" | "product_edit";
    reason?:   string | null;
  },
): Promise<boolean> {
  const { before, after } = args;
  if (!priceMoved(before, after)) return false;

  await tx`
    INSERT INTO price_revisions (
      product_id,
      old_price, new_price,
      old_dealer_price, new_dealer_price,
      old_mrp, new_mrp,
      old_gst_percent, new_gst_percent,
      effective_from, changed_by, reason, source
    ) VALUES (
      ${args.productId},
      ${asNumeric(before.basePrice)}::numeric,   ${asNumeric(after.basePrice)}::numeric,
      ${asNumeric(before.dealerPrice)}::numeric, ${asNumeric(after.dealerPrice)}::numeric,
      ${asNumeric(before.mrp)}::numeric,         ${asNumeric(after.mrp)}::numeric,
      ${asNumeric(before.gstPercent)}::numeric,  ${asNumeric(after.gstPercent)}::numeric,
      ${istToday()}::date,
      ${args.changedBy},
      ${args.reason ?? null},
      ${args.source}
    )
  `;
  return true;
}

// ── Subsidy milk follows HTM 1000ML ──────────────────────────────────
// HTM 1000ML (Subsidy) is the same pouch sold at half price (migration
// 0056). It was seeded at half of HTM 1000ML once, so a later price change
// on HTM 1000ML left the subsidy rate behind. Every price save on HTM 1000ML
// now re-sets the subsidy SKU to half, in the same transaction.
export const SUBSIDY_SOURCE_CODE = "PD0191";   // HTM 1000ML
export const SUBSIDY_PRODUCT_CODE = "PD0191S"; // HTM 1000ML (Subsidy)

const half = (v: number | string) => Math.round(Number(v) * 50) / 100;

/**
 * If productId is HTM 1000ML, set HTM 1000ML (Subsidy) to half its Dealer
 * Price and MRP (and the rate-category prices that follow them), and log it.
 * No-op for any other product. Run inside the caller's transaction, after
 * the HTM 1000ML row has been written.
 */
export async function syncSubsidyPrice(
  tx: typeof pgClient,
  productId: string,
  changedBy: string,
): Promise<void> {
  const [src] = await tx`
    SELECT dealer_price, mrp FROM products
    WHERE id = ${productId} AND code = ${SUBSIDY_SOURCE_CODE} AND deleted_at IS NULL
  `;
  if (!src) return;

  const [sub] = await tx`
    SELECT id, base_price, dealer_price, mrp, gst_percent FROM products
    WHERE code = ${SUBSIDY_PRODUCT_CODE} AND deleted_at IS NULL
    FOR UPDATE
  `;
  if (!sub) return;

  const dealer = half(src.dealer_price);
  const mrp = half(src.mrp);
  const base = deriveBasePriceFromDealerPrice(dealer, Number(sub.gst_percent));

  const [row] = await tx`
    UPDATE products SET
      dealer_price             = ${dealer}::numeric,
      mrp                      = ${mrp}::numeric,
      base_price               = ${base}::numeric,
      retail_dealer_price      = ${dealer}::numeric,
      credit_inst_dealer_price = ${dealer}::numeric,
      parlour_dealer_price     = ${dealer}::numeric,
      credit_inst_mrp_price    = ${mrp}::numeric,
      updated_at               = now()
    WHERE id = ${sub.id}
    RETURNING base_price, dealer_price, mrp, gst_percent
  `;
  await recordPriceRevision(tx, {
    productId: sub.id,
    before: {
      basePrice: sub.base_price, dealerPrice: sub.dealer_price,
      mrp: sub.mrp, gstPercent: sub.gst_percent,
    },
    after: {
      basePrice: row!.base_price, dealerPrice: row!.dealer_price,
      mrp: row!.mrp, gstPercent: row!.gst_percent,
    },
    changedBy,
    source: "price_revision",
    reason: "Half of HTM 1000ML (subsidy scheme)",
  });
  await repriceOpenDrafts(tx, sub.id);
}

export interface AppliedPriceRevision {
  productId:      string;
  code:           string | null;
  name:           string;
  oldDealerPrice: string | null;
  newDealerPrice: string;
  oldMrp:         string | null;
  newMrp:         string;
  oldBasePrice:   string;
  newBasePrice:   string;
}

/**
 * One line of a Price Revisions batch: sets the product's Dealer Price and/or
 * MRP (whichever is given; the other keeps its current value), re-derives
 * base_price when the Dealer Price moves, and logs it. Run inside the batch
 * transaction. Returns null when the line changes nothing.
 */
export async function applyPriceRevision(
  tx: typeof pgClient,
  rev: {
    productId:       string;
    newDealerPrice?: number | undefined;
    newMrp?:         number | undefined;
    changedBy:       string;
    reason?:         string | null | undefined;
  },
): Promise<AppliedPriceRevision | null> {
  const [p] = await tx`
    SELECT id, code, name, base_price, dealer_price, mrp, gst_percent
    FROM products
    WHERE id = ${rev.productId} AND deleted_at IS NULL
    FOR UPDATE
  `;
  if (!p) throw new PriceRevisionError("A product in this revision no longer exists. Reload the page.", 404);

  const label = p.code ?? p.name;
  const newDealer = rev.newDealerPrice ?? Number(p.dealer_price);
  const newMrp = rev.newMrp ?? Number(p.mrp);
  if (!(newDealer > 0)) throw new PriceRevisionError(`${label}: enter a Dealer Price.`);
  if (!(newMrp > 0)) throw new PriceRevisionError(`${label}: enter an MRP.`);
  if (toPaise(newMrp)! < toPaise(newDealer)!) {
    throw new PriceRevisionError(
      `${label}: MRP ${rupees(newMrp)} is below the Dealer Price ${rupees(newDealer)}.`,
    );
  }

  // Basic Price follows the Dealer Price. Left alone on an MRP-only change,
  // so it is not rewritten for nothing.
  const dealerMoved = toPaise(newDealer) !== toPaise(p.dealer_price);
  const newBase = dealerMoved
    ? deriveBasePriceFromDealerPrice(newDealer, Number(p.gst_percent))
    : p.base_price;

  const before: PriceSnapshot = {
    basePrice: p.base_price, dealerPrice: p.dealer_price,
    mrp: p.mrp, gstPercent: p.gst_percent,
  };
  if (!priceMoved(before, {
    basePrice: newBase, dealerPrice: newDealer, mrp: newMrp, gstPercent: p.gst_percent,
  })) return null;

  const [row] = await tx`
    UPDATE products SET
      dealer_price = ${newDealer}::numeric,
      mrp          = ${newMrp}::numeric,
      base_price   = ${String(newBase)}::numeric,
      updated_at   = now()
    WHERE id = ${p.id}
    RETURNING base_price, dealer_price, mrp, gst_percent
  `;
  await recordPriceRevision(tx, {
    productId: p.id,
    before,
    after: {
      basePrice: row!.base_price, dealerPrice: row!.dealer_price,
      mrp: row!.mrp, gstPercent: row!.gst_percent,
    },
    changedBy: rev.changedBy,
    source: "price_revision",
    reason: rev.reason ?? null,
  });
  await repriceOpenDrafts(tx, p.id);
  await syncSubsidyPrice(tx, p.id, rev.changedBy);

  return {
    productId: p.id, code: p.code, name: p.name,
    oldDealerPrice: p.dealer_price, newDealerPrice: row!.dealer_price,
    oldMrp: p.mrp, newMrp: row!.mrp,
    oldBasePrice: p.base_price, newBasePrice: row!.base_price,
  };
}
