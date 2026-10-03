// ═══════════════════════════════════════════════════════════════════════
// apps/api/src/lib/refund-accounting.ts
//
// One definition of "how much of this order may still be refunded", shared
// by every path that hands money back: the modify-indent bank refund
// (order-refund.ts), the admin cancel (cancel-order.ts) and the Finance >
// Online Payments refund (routes/finance-razorpay.ts).
//
// It lives in its own module rather than in order-refund.ts because
// cancel-order.ts and order-refund.ts already import from each other.
// ═══════════════════════════════════════════════════════════════════════

import { pgClient } from "./db.js";

/**
 * Net rupees already handed back to the dealer on the BALANCE rail for an
 * order: the wallet credits and available-balance credits written by a
 * downward "modify indent" or by a cancel that refunded to store credit,
 * less any debit an upward modify took back again.
 *
 * This exists because the two refund rails cannot see each other. A refund
 * paid onto the balance writes a dealer_ledger credit and never touches
 * razorpay_payments.amount_refunded, so anything that sizes a gateway refund
 * from the gateway counter alone will happily pay the same rupees twice.
 * Order 75b8e03f-c197-4568-ba16-b48f297f94ea (2026-08-29) went out that way:
 * Rs 1,323.88 to the available balance on a modify, then another Rs 1,323.88
 * to the bank on the cancel, against one Rs 1,323.88 payment.
 *
 * The row predicate is the same one the Day Book uses for "order-change
 * balance movements" (routes/finance-day-book.ts, section 3b), so the books
 * and the refund ceiling agree on what counts:
 *   • reference_type adjustment                     → modify up (debit) / down (credit)
 *   • credit on refund                              → cancel of a wallet order
 *   • credit on order with voucher_type Adjustment → cancel to available balance
 * The placement debit (also on order, voucher Invoice or none) is the
 * charge itself, not a refund, and is excluded by the credit-only guard.
 * voucher_type Receipt is excluded for the same reason it is there: a
 * cash / cheque / on-account receipt also lands on adjustment.
 */
export async function balanceRefundedForOrder(
  sql: typeof pgClient,
  orderId: string,
): Promise<number> {
  const [row] = await sql`
    SELECT COALESCE(SUM(CASE WHEN dl.type = 'credit' THEN dl.amount
                             ELSE -dl.amount END), 0)::float8 AS net
      FROM dealer_ledger dl
     WHERE dl.reference_id = ${orderId}::uuid
       AND COALESCE(dl.voucher_type, '') <> 'Receipt'
       AND (
             dl.reference_type = 'adjustment'
          OR (dl.type = 'credit' AND dl.reference_type = 'refund')
          OR (dl.type = 'credit' AND dl.reference_type = 'order'
              AND dl.voucher_type = 'Adjustment')
           )
  `;
  return Number(row?.net ?? 0);
}

/**
 * Net rupees that were actually taken OFF the dealer's wallet for an order.
 *
 * The wallet reversal on a cancel used to be sized from orders.grand_total
 * alone, on the strength of payment_mode = 'wallet'. But payment_mode records
 * an INTENTION, not a movement: prod carries wallet-mode orders that never
 * debited the wallet at all, and crediting grand_total back on one of those
 * hands the dealer money the union never held. The ledger is the evidence, so
 * the reversal is sized from it.
 *
 * Every path that moves dealer_wallets.balance writes its ledger row in the
 * SAME transaction as the UPDATE (the placement debit in routes/orders.ts,
 * the modify up/down pair, and this module's own cancellation credit), so the
 * ledger is a faithful record of what left the wallet:
 *
 *   placement   debit  on reference_type 'order'
 *   modify up   debit  on 'adjustment'
 *   modify down credit on 'adjustment'
 *   cancel      credit on 'refund'
 *
 * netting to: Σ debits − Σ credits, i.e. what the dealer is still out of
 * pocket for this order. Zero (or less) means nothing is owed back.
 *
 * voucher_type 'Receipt' is excluded for the same reason it is in
 * balanceRefundedForOrder: a cash / cheque / on-account receipt also lands on
 * reference_type 'adjustment', and that is money coming IN, not a wallet
 * movement for this order.
 */
export async function walletDebitedForOrder(
  sql: typeof pgClient,
  orderId: string,
): Promise<number> {
  const [row] = await sql`
    SELECT COALESCE(SUM(CASE WHEN dl.type = 'debit' THEN dl.amount
                             ELSE -dl.amount END), 0)::float8 AS net
      FROM dealer_ledger dl
     WHERE dl.reference_id = ${orderId}::uuid
       AND COALESCE(dl.voucher_type, '') <> 'Receipt'
       AND dl.reference_type IN ('order', 'adjustment', 'refund')
  `;
  return Number(row?.net ?? 0);
}

/**
 * How much of a captured online payment may still be refunded to the bank,
 * once the balance rail is taken into account.
 *
 * `gatewayRemaining` is amount − amount_refunded. Whatever has already gone
 * back as store credit for the same order comes off the top, because the
 * dealer has had those rupees once already. A NEGATIVE balance figure (an
 * upward modify, which took money OFF the balance) is ignored rather than
 * added: that extra was collected from the balance, so it must go back there
 * and not out through a gateway that never received it.
 */
export function refundableToBank(
  gatewayRemaining: number,
  balanceRefunded: number,
): number {
  return Math.max(0, gatewayRemaining - Math.max(0, balanceRefunded));
}
