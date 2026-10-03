// ═══════════════════════════════════════════════════════════════════════
// apps/api/src/lib/supersede-orders.ts
//
// One indent invariant: AT MOST ONE live order per (dealer, delivery_date).
//
// The DB cannot enforce it — orders is PARTITIONED BY RANGE (created_at),
// and Postgres requires every unique index on a partitioned table to
// include the partition key, so uq_orders_dealer_delivery_active
// (migration 0034) exists but guarantees nothing across partitions in
// practice. The result (July 2026 data): dealers with a paid, dispatched
// order AND a stranded draft/payment_required twin for the same date —
// identical items, "awaiting payment" badge, and a live "Pay for this
// indent" button that would charge them twice.
//
// This helper is the application-level enforcement: the moment an order
// is PLACED (confirmed via cart, dealer confirm, admin confirm, Razorpay
// payment, subsidy-place, or the worker's auto-confirm), every OTHER
// same-day order for that dealer that is still unpaid and unbooked is
// cancelled as superseded.
//
// Safety guards — a sibling is only cancelled when ALL hold:
//   • status is 'draft' or 'payment_required' (never a placed order)
//   • no razorpay_payments row with status='paid' (captured money is
//     sacred — reconciliation confirms those, mirrors HMU-2A9B rule)
//   • no dealer_ledger 'order' debit (a booked order needs a human, not
//     a silent cancel)
// Stock latched by a cancelled sibling (cart-UPI orders deduct at
// creation) is restored via the stock_deducted latch, exactly once.
//
// MUST run inside the caller's transaction so the winner's confirm and
// the losers' cancellation commit (or roll back) together.
//
// The worker has its own mirrored copy in
// apps/worker/src/jobs/auto-confirm-drafts.ts (the worker is its own
// package) — keep the two in sync.
// ═══════════════════════════════════════════════════════════════════════

import { pgClient } from "./db.js";
import { restoreOrderStock } from "./stock-check.js";

// Prefix of the cancellation_reason written for superseded twins.
// dealer-payments.ts recognises it to REVIVE a superseded order whose
// online payment turns out to have been captured (same principle as
// AUTO_DISCARD_REASON).
export const SUPERSEDE_REASON_PREFIX = "Superseded by placed order ";

/**
 * Cancel every unpaid, unbooked draft/payment_required sibling of a
 * just-placed order (same dealer, same delivery_date). Idempotent —
 * re-running finds nothing left to cancel. Returns the cancelled ids.
 */
export async function cancelSupersededSiblings(
  tx: typeof pgClient,
  winnerOrderId: string
): Promise<string[]> {
  const losers = await tx`
    UPDATE orders o
       SET status = 'cancelled',
           cancellation_reason = ${SUPERSEDE_REASON_PREFIX + winnerOrderId},
           cancelled_at = now(),
           updated_at = now()
      FROM orders w
     WHERE w.id = ${winnerOrderId}::uuid
       AND o.dealer_id = w.dealer_id
       AND o.delivery_date = w.delivery_date
       -- Per-route indent: a placed order only supersedes siblings on the
       -- SAME route, so a two-route dealer's route-A order never cancels
       -- their route-B order for the same day. (NOT DISTINCT so legacy
       -- NULL-route rows still supersede each other.)
       AND o.route_id IS NOT DISTINCT FROM w.route_id
       AND o.id <> w.id
       AND o.status IN ('draft', 'payment_required')
       AND NOT EXISTS (
             SELECT 1 FROM razorpay_payments rp
              WHERE rp.order_id = o.id AND rp.status = 'paid'
           )
       AND NOT EXISTS (
             SELECT 1 FROM dealer_ledger dl
              WHERE dl.reference_id = o.id
                AND dl.reference_type = 'order'
                AND dl.type = 'debit'
           )
    RETURNING o.id::text AS id
  `;

  // Cart-UPI orders latch stock_deducted at creation; give it back.
  // restoreOrderStock is latch-guarded, so drafts (never deducted) no-op.
  for (const l of losers as unknown as Array<{ id: string }>) {
    await restoreOrderStock(tx, l.id);
  }

  return (losers as unknown as Array<{ id: string }>).map((r) => r.id);
}
