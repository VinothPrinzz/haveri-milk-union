// apps/worker/src/lib/line-totals.ts
// ════════════════════════════════════════════════════════════════════
// The ONE rounding rule for every order, indent and counter sale.
//
// ── The rule: round at the LINE, then add up ────────────────────────
//
//     lineSubtotal = round2(unitPrice x qty)
//     lineGst      = round2(lineSubtotal x gst%)
//     lineTotal    = lineSubtotal + lineGst          ← already exact @2dp
//     subtotal     = Σ lineSubtotal
//     totalGst     = Σ lineGst
//     grandTotal   = subtotal + totalGst             ← == Σ lineTotal
//
// so `grandTotal` is the sum of the amounts actually PRINTED on the
// invoice, to the paisa, by construction.
//
// ── Why this module exists ──────────────────────────────────────────
// Several order paths used to add up the UNROUNDED line values and round
// once at the end (sum-then-round) while storing each `line_total`
// rounded (round-then-sum). Those two disagree: on 3,129 August 2026
// orders the printed lines summed to 1-3 paise away from the invoice
// total, so the invoice did not foot. Net Rs 6.08 that month, growing
// with volume, and it also split `subtotal + total_gst` from
// `grand_total` on some orders.
//
// No dealer was ever mischarged — `grand_total` is what Razorpay took and
// what the invoice header showed — but a GST invoice whose line items do
// not add up to its total is not a document you want to hand an auditor.
//
// A 3-decimal `base_price` makes it worse, but is NOT the root cause:
// 5% GST on a clean Rs 45.71 is Rs 47.9955 regardless. Rounding has to
// happen at the line, which is what this does.
//
// ── Do not "fix" history with this ──────────────────────────────────
// Past `grand_total` values must never be recomputed: they are what the
// dealer actually paid and what their invoice says. Only new documents
// get the corrected arithmetic.
//
// Mirrored verbatim from apps/api/src/lib/line-totals.ts — the worker
// builds standing-indent drafts and must round identically to the API.
// Keep the two in sync (same convention as lib/rate-price.ts).
// ════════════════════════════════════════════════════════════════════

/** Rupees to the paisa. */
export const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface LineTotals {
  /** Net (pre-GST) line value, rupees @ 2dp. */
  subtotal: number;
  /** GST on the line, rupees @ 2dp. */
  gst: number;
  /** subtotal + gst. Exact @2dp — this is the printed line amount. */
  total: number;
}

/**
 * Line amounts from (net unit price, gst %, quantity).
 *
 * `unitPrice` is NET of GST — every caller multiplies by quantity and adds
 * GST on top (see lib/rate-price.ts on why the price columns are net).
 */
export function calcLine(
  unitPrice: number,
  gstPercent: number,
  qty: number
): LineTotals {
  const subtotal = round2(unitPrice * qty);
  const gst = round2(subtotal * (gstPercent / 100));
  // Both parts are already exact to the paisa, so this rounds away float
  // noise only — it is NOT a second rounding, which is what keeps
  // Σ total === Σ subtotal + Σ gst.
  return { subtotal, gst, total: round2(subtotal + gst) };
}

/**
 * Document totals from its lines. `grandTotal` is guaranteed equal to the
 * sum of the lines' `total`, so the invoice foots.
 */
export function sumLines(lines: readonly LineTotals[]): {
  subtotal: number;
  totalGst: number;
  grandTotal: number;
} {
  let subtotal = 0;
  let totalGst = 0;
  for (const l of lines) {
    subtotal = round2(subtotal + l.subtotal);
    totalGst = round2(totalGst + l.gst);
  }
  return { subtotal, totalGst, grandTotal: round2(subtotal + totalGst) };
}
