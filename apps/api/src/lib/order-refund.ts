// ═══════════════════════════════════════════════════════════════════════
// apps/api/src/lib/order-refund.ts
//
// Partial-refund helpers for the "modify indent" flow. When an admin edits a
// confirmed indent DOWNWARD, the difference must go back to the dealer — and
// the admin chooses where:
//   • "balance"  → store credit on the dealer's available balance (a
//                  dealer_ledger credit). Handled inline by the modify route.
//   • "razorpay" → a bank refund of the difference against the order's
//                  captured online payment. That is what this module does.
//
// The logic mirrors adminCancelOrder (apps/api/src/lib/cancel-order.ts) but
// refunds a PARTIAL amount (the edit delta) instead of the whole order and
// does NOT cancel anything. As there, the gateway call runs BEFORE the DB
// transaction (initiateOrderBankRefund); the DB side is persisted inside the
// modify tx (recordBankRefund).
// ═══════════════════════════════════════════════════════════════════════

import { pgClient } from "./db.js";
import { isRazorpayConfigured, createRazorpayRefund } from "./razorpay-client.js";
import { RefundError } from "./cancel-order.js";

export interface BankRefundIntent {
  rpRowId: string;
  rzpPaymentId: string;
  dealerId: string;
  refundAmt: number;
  rzpRefund: { id: string; status: string };
}

/**
 * Initiate a Razorpay (bank) refund of `amount` against an order's captured
 * online payment. MUST be called BEFORE opening the modify DB transaction so
 * a gateway failure leaves nothing half-written. Throws RefundError (→ 409)
 * when the refund can't be carried out: no captured online payment, the
 * amount exceeds the unrefunded balance, or Razorpay is unconfigured/rejects.
 * Returns an intent to persist in-tx via recordBankRefund.
 */
export async function initiateOrderBankRefund(
  orderId: string,
  amount: number,
  reason: string,
): Promise<BankRefundIntent> {
  const [rp] = await pgClient`
    SELECT id, dealer_id::text AS "dealerId",
           amount::numeric AS amount, amount_refunded::numeric AS "amountRefunded",
           razorpay_payment_id AS "rzpPaymentId"
      FROM razorpay_payments
     WHERE order_id = ${orderId} AND kind = 'order_payment' AND status = 'paid'
     ORDER BY created_at DESC
     LIMIT 1
  `;
  const paidRemaining = rp
    ? Math.max(0, parseFloat(rp.amount) - parseFloat(rp.amountRefunded))
    : 0;

  if (!rp || paidRemaining <= 0.001) {
    throw new RefundError(
      "This order has no refundable online payment, so it can't be refunded to a bank account. Choose 'available balance' instead.",
    );
  }
  if (amount - paidRemaining > 0.01) {
    throw new RefundError(
      `The refund (₹${amount.toFixed(2)}) exceeds the refundable online payment ` +
        `(₹${paidRemaining.toFixed(2)}). Refund to the available balance instead.`,
    );
  }
  if (!isRazorpayConfigured()) {
    throw new RefundError(
      "Razorpay is not configured — cannot refund to a bank account. Choose 'available balance' instead.",
    );
  }
  if (!rp.rzpPaymentId) {
    throw new RefundError(
      "This order's payment has no Razorpay payment id — cannot refund to a bank account. Choose 'available balance' instead.",
    );
  }

  const refundAmt = Math.min(amount, paidRemaining);
  let rzpRefund: { id: string; status: string };
  try {
    rzpRefund = await createRazorpayRefund({
      paymentId: rp.rzpPaymentId,
      amountInRupees: refundAmt,
      notes: { reason, orderId, dealerId: rp.dealerId },
    });
  } catch (err: any) {
    throw new RefundError(err?.message ?? "Razorpay rejected the refund.");
  }

  return {
    rpRowId: rp.id,
    rzpPaymentId: rp.rzpPaymentId,
    dealerId: rp.dealerId,
    refundAmt,
    rzpRefund,
  };
}

/**
 * Persist a completed gateway refund inside the modify transaction: a
 * reversing ledger debit (only when the original online payment posted a
 * credit — matching adminCancelOrder), a razorpay_refunds row, and the
 * amount_refunded/status counters on razorpay_payments. Never touches the
 * available balance for the "went to bank" case beyond that reversing debit.
 */
export async function recordBankRefund(
  tx: typeof pgClient,
  intent: BankRefundIntent,
  reason: string,
  performedBy: string,
) {
  const { rpRowId, rzpPaymentId, dealerId, refundAmt, rzpRefund } = intent;

  const [origCredit] = await tx`
    SELECT id FROM dealer_ledger
     WHERE dealer_id = ${dealerId}::uuid
       AND type = 'credit'
       AND description LIKE ${"%" + rzpPaymentId + "%"}
     LIMIT 1
  `;

  let ledgerEntryId: string | null = null;
  if (origCredit) {
    const [bal] = await tx`
      SELECT COALESCE(d.opening_balance, 0)
           + COALESCE((
               SELECT SUM(CASE WHEN dl.type = 'credit' THEN dl.amount
                               WHEN dl.type = 'debit'  THEN -dl.amount END)
                 FROM dealer_ledger dl
                WHERE dl.dealer_id = d.id
                  AND COALESCE(dl.voucher_type, '') <> 'Opening'
             ), 0) AS bal
        FROM dealers d
       WHERE d.id = ${dealerId}::uuid
    `;
    const balanceAfter = parseFloat(bal!.bal) - refundAmt;
    const desc = `Razorpay refund ${rzpRefund.id} for ${rzpPaymentId} — modify: ${reason}`;
    const [led] = await tx`
      INSERT INTO dealer_ledger (
        dealer_id, type, amount,
        reference_id, reference_type,
        description, balance_after, performed_by,
        voucher_no, voucher_type, particulars, voucher_date
      ) VALUES (
        ${dealerId}::uuid, 'debit',
        ${refundAmt.toFixed(2)}::numeric,
        ${rpRowId}::uuid, 'refund'::ledger_ref_type,
        ${desc}, ${balanceAfter.toFixed(2)}::numeric, ${performedBy}::uuid,
        ${"RF-" + rzpRefund.id.slice(-8).toUpperCase()},
        'Refund', ${desc},
        (now() AT TIME ZONE 'Asia/Kolkata')::date
      )
      RETURNING id
    `;
    ledgerEntryId = led!.id;
  }

  await tx`
    INSERT INTO razorpay_refunds (
      razorpay_payment_row, dealer_id,
      razorpay_refund_id, razorpay_payment_id,
      amount, status, reason, initiated_by, ledger_entry_id
    ) VALUES (
      ${rpRowId}::uuid, ${dealerId}::uuid,
      ${rzpRefund.id}, ${rzpPaymentId},
      ${refundAmt.toFixed(2)}::numeric,
      ${rzpRefund.status === "processed" ? "processed" : "pending"}::razorpay_refund_status,
      ${reason}, ${performedBy}::uuid, ${ledgerEntryId}::uuid
    )
  `;

  await tx`
    UPDATE razorpay_payments
       SET amount_refunded = amount_refunded + ${refundAmt.toFixed(2)}::numeric,
           status = CASE WHEN amount_refunded + ${refundAmt.toFixed(2)}::numeric >= amount - 0.001
                         THEN 'refunded'::razorpay_payment_status
                         ELSE status END,
           updated_at = now()
     WHERE id = ${rpRowId}::uuid
  `;
}
