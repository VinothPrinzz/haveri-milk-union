// ═══════════════════════════════════════════════════════════════════════
// apps/api/src/lib/credit-check.ts
//
// Single source of truth for "can this dealer afford this order?".
// Called from:
//   • POST /api/v1/dealer/drafts/:date/confirm   (Phase 2A)
//   • POST /api/v1/orders                         (existing — same logic)
//   • Worker auto-confirm                         (Phase 3)
//
// Outstanding model (mirrors the admin web's payment-overview math):
//   outstanding = SUM(grand_total)
//                 FROM orders
//                 WHERE dealer_id = $1
//                   AND payment_mode = 'credit'
//                   AND status NOT IN ('cancelled', 'delivered')
//
//   available   = credit_limit - outstanding
//
// We treat 'draft' and 'payment_required' as NOT outstanding — they
// haven't actually committed to debiting credit yet. Only 'pending',
// 'confirmed', and 'dispatched' count.
// ═══════════════════════════════════════════════════════════════════════

import { pgClient } from "./db.js";

export interface CreditCheckResult {
  /** Hard limit set by admin (numeric, INR) */
  creditLimit: number;
  /** Currently outstanding (sum of un-delivered credit orders, INR) */
  outstanding: number;
  /** Limit minus outstanding (INR, never negative) */
  available: number;
  /** Order total being checked (INR) */
  orderTotal: number;
  /** True if the order fits within available credit */
  sufficient: boolean;
  /** orderTotal - available, only set when !sufficient (INR) */
  shortfall: number;
}

/**
 * Check whether a dealer can absorb `orderTotal` against their
 * credit limit. Pure read — does not mutate any state.
 *
 * The caller is responsible for taking action on the result:
 *   • sufficient=true → proceed with the credit-mode order
 *   • sufficient=false → either prompt for Razorpay payment, or mark
 *     the order as 'payment_required' (worker path)
 */
export async function checkDealerCredit(
  dealerId: string,
  orderTotal: number
): Promise<CreditCheckResult> {
  const [row] = await pgClient`
    SELECT
      COALESCE(d.credit_limit, 0)::numeric AS credit_limit,
      (
        COALESCE(d.opening_balance, 0)
        + COALESCE((
            SELECT SUM(CASE WHEN dl.type = 'credit' THEN dl.amount
                            WHEN dl.type = 'debit'  THEN -dl.amount END)
              FROM dealer_ledger dl
            WHERE dl.dealer_id = d.id
              AND COALESCE(dl.voucher_type, '') <> 'Opening'
          ), 0)
      )::numeric AS closing_balance
    FROM dealers d
    WHERE d.id = ${dealerId} AND d.deleted_at IS NULL
  `;

  if (!row) {
    throw new Error(`Dealer ${dealerId} not found`);
  }

  const creditLimit = parseFloat(row.credit_limit);
  const closing     = parseFloat(row.closing_balance);
  const outstanding = closing < 0 ? -closing : 0;
  const available   = Math.max(0, creditLimit + closing);   // was: creditLimit - outstanding
  const sufficient = orderTotal <= available;
  const shortfall = sufficient ? 0 : Math.round((orderTotal - available) * 100) / 100;

  return {
    creditLimit: round2(creditLimit),
    outstanding: round2(outstanding),
    available: round2(available),
    orderTotal: round2(orderTotal),
    sufficient,
    shortfall,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}