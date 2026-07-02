import { pgClient } from "./db.js";
import { restoreOrderStock } from "./stock-check.js";
import { isRazorpayConfigured, createRazorpayRefund } from "./razorpay-client.js";

/**
 * Raised when a cancellation's refund can't be carried out the way the
 * admin asked (e.g. a bank/Razorpay refund requested for an order that has
 * no captured online payment, or Razorpay isn't configured). The
 * admin-cancel route maps this to a 409 so the operator knows the cancel
 * was NOT performed.
 */
export class RefundError extends Error {
  statusCode = 409;
  constructor(message: string) {
    super(message);
    this.name = "RefundError";
  }
}

/**
 * Where the admin wants a cancellation refund to go:
 *   • "razorpay" → back to the dealer's bank via a Razorpay gateway refund
 *     (only possible when the order has a captured online payment).
 *   • "balance"  → onto the dealer's available balance as store credit
 *     (a dealer_ledger credit; wallet orders also restore the wallet).
 */
export type RefundMethod = "razorpay" | "balance";

/** What an admin cancel did to put the dealer's money back. */
export interface RefundSummary {
  paymentMode: string;
  refund: {
    method: "wallet" | "credit" | "razorpay" | "none";
    amount: number;
    razorpayRefundId?: string;
    status?: string;
  };
}

/**
 * Instruction for the balance-side reversal (money back as store credit),
 * decided by adminCancelOrder. "none" means nothing is owed to the balance
 * (e.g. the refund is going to the bank, or the order was never paid).
 */
type BalancePlan =
  | { to: "none" }
  | { to: "wallet"; amount: number }
  | { to: "ledger"; amount: number };

/**
 * Cancels an order and reverses its effects: the product-stock restore (the
 * inverse of the deduction done at confirm) and, per `plan`, the balance
 * reversal (wallet refund or credit-ledger credit). MUST run inside a
 * transaction — pass the tx client. Gateway (Razorpay) refunds are NOT done
 * here; adminCancelOrder layers those on around this call.
 */
export async function cancelOrderWithReversal(
  tx: typeof pgClient,
  orderId: string,
  reason: string,
  performedBy: string,
  plan: BalancePlan = { to: "none" },
) {
  await tx`
    UPDATE orders
       SET status = 'cancelled', cancelled_at = now(),
           cancellation_reason = ${reason}, updated_at = now()
     WHERE id = ${orderId}
  `;

  // Put physical stock back for every line.
  await restoreOrderStock(tx, orderId);

  const [order] = await tx`
    SELECT payment_mode, grand_total, dealer_id
      FROM orders WHERE id = ${orderId}
  `;
  if (!order) throw new Error("Order not found");

  if (plan.to === "wallet") {
    const [wallet] = await tx`
      UPDATE dealer_wallets
         SET balance = balance + ${plan.amount.toFixed(2)}::numeric, updated_at = now()
       WHERE dealer_id = ${order.dealer_id}
      RETURNING balance
    `;
    await tx`
      INSERT INTO dealer_ledger
        (dealer_id, type, amount, reference_id, reference_type,
         description, balance_after, performed_by)
      VALUES
        (${order.dealer_id}, 'credit', ${plan.amount.toFixed(2)}::numeric,
         ${orderId}, 'refund', 'Cancellation refund',
         ${wallet!.balance}::numeric, ${performedBy})
    `;
  } else if (plan.to === "ledger") {
    // Credit the dealer's available balance (prepaid model): a credit ledger
    // row raises closing_balance and therefore available. Covers credit
    // orders (reverses the placement debit) and online-paid orders whose
    // admin chose store credit instead of a bank refund.
    const [bal] = await tx`
      SELECT
        COALESCE(d.opening_balance, 0)
        + COALESCE((SELECT SUM(CASE WHEN dl.type='credit'
              AND COALESCE(dl.voucher_type,'') <> 'Opening'
              THEN dl.amount ELSE 0 END)
            FROM dealer_ledger dl WHERE dl.dealer_id = d.id), 0)
        - COALESCE((SELECT SUM(CASE WHEN dl.type='debit'
              AND COALESCE(dl.voucher_type,'') <> 'Opening'
              THEN dl.amount ELSE 0 END)
            FROM dealer_ledger dl WHERE dl.dealer_id = d.id), 0)
        AS bal
      FROM dealers d WHERE d.id = ${order.dealer_id}
    `;
    const balanceAfter = parseFloat(bal!.bal) + plan.amount;
    await tx`
      INSERT INTO dealer_ledger
        (dealer_id, type, amount, reference_id, reference_type,
         voucher_type, voucher_date, description, balance_after, performed_by)
      VALUES
        (${order.dealer_id}, 'credit',
         ${plan.amount.toFixed(2)}::numeric,
         ${orderId}, 'order', 'Adjustment', now()::date,
         ${'Cancellation credit — order ' + orderId},
         ${balanceAfter.toFixed(2)}::numeric, ${performedBy})
    `;
  }
}

/**
 * Admin-side cancel for an indent. The admin picks where the refund goes via
 * `refundMethod`:
 *   • "razorpay" → Razorpay refund to the dealer's bank for the unrefunded
 *                  balance of the order's captured online payment. Only valid
 *                  when such a payment exists; otherwise a RefundError is
 *                  raised and NO cancel happens.
 *   • "balance"  → credit the dealer's available balance (store credit):
 *                    - wallet → wallet balance + ledger credit
 *                    - credit → ledger credit (reverses the placement debit)
 *                    - online-paid → ledger credit for the paid amount
 *                    - unpaid / cash → nothing to refund (order still cancels)
 *
 * When `refundMethod` is omitted the legacy auto-rule applies: online-paid
 * orders go to the bank, everything else to the available balance.
 *
 * The Razorpay call is made BEFORE the DB transaction is opened — a gateway
 * failure then leaves nothing half-written and throws (no cancel happens).
 * Returns a summary the API surfaces to the operator.
 */
export async function adminCancelOrder(
  orderId: string,
  reason: string,
  performedBy: string,
  refundMethod?: RefundMethod,
): Promise<RefundSummary> {
  const [order] = await pgClient`
    SELECT payment_mode, grand_total, dealer_id
      FROM orders WHERE id = ${orderId} LIMIT 1
  `;
  if (!order) throw new Error("Order not found");
  const grandTotal = parseFloat(order.grand_total);

  // Captured online payment for this order (if any). Needed both to issue a
  // bank refund and to know an online-paid order actually had money change
  // hands (so "balance" only grants store credit for what was paid).
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
  const canBankRefund = !!rp && paidRemaining > 0.001;

  // ── Resolve the effective refund method ──
  let method: RefundMethod | "none";
  if (refundMethod === "razorpay") {
    if (!canBankRefund) {
      throw new RefundError(
        "This order has no refundable online payment, so it can't be refunded to a bank account. Choose 'available balance' instead.",
      );
    }
    method = "razorpay";
  } else if (refundMethod === "balance") {
    method = "balance";
  } else {
    // Back-compat auto: online-paid → bank; everything else → balance.
    method = order.payment_mode === "upi" && canBankRefund ? "razorpay" : "balance";
  }

  // ── Razorpay path: resolve the gateway refund up front (outside the tx) ──
  let upi:
    | { rpRowId: string; rzpPaymentId: string; dealerId: string; refundAmt: number;
        rzpRefund: { id: string; status: string } }
    | null = null;

  if (method === "razorpay") {
    if (!isRazorpayConfigured()) {
      throw new RefundError(
        "Razorpay is not configured — cannot refund to a bank account. Cancel aborted.",
      );
    }
    if (!rp!.rzpPaymentId) {
      throw new RefundError(
        "This order's payment has no Razorpay payment id — cannot refund to a bank account. Cancel aborted.",
      );
    }
    let rzpRefund: { id: string; status: string };
    try {
      rzpRefund = await createRazorpayRefund({
        paymentId: rp!.rzpPaymentId,
        amountInRupees: paidRemaining,
        notes: { reason, orderId, dealerId: rp!.dealerId },
      });
    } catch (err: any) {
      throw new RefundError(
        err?.message ?? "Razorpay rejected the refund. Cancel aborted.",
      );
    }
    upi = {
      rpRowId: rp!.id,
      rzpPaymentId: rp!.rzpPaymentId,
      dealerId: rp!.dealerId,
      refundAmt: paidRemaining,
      rzpRefund,
    };
  }

  // ── Balance path: decide what (if anything) to credit back ──
  let plan: BalancePlan = { to: "none" };
  if (method === "balance") {
    if (order.payment_mode === "wallet") {
      plan = { to: "wallet", amount: grandTotal };
    } else if (order.payment_mode === "credit") {
      plan = { to: "ledger", amount: grandTotal };
    } else if (canBankRefund) {
      // Online-paid order, but the admin chose store credit over a bank
      // refund — credit the paid amount to the available balance.
      plan = { to: "ledger", amount: paidRemaining };
    } else {
      // Unpaid (e.g. payment_required) or cash — nothing was collected, so
      // there is nothing to put on the balance. Order still cancels.
      plan = { to: "none" };
    }
  }

  await pgClient.begin(async (_tx) => {
    const tx = _tx as unknown as typeof pgClient;

    // Cancel + stock restore + (per plan) balance reversal.
    await cancelOrderWithReversal(tx, orderId, reason, performedBy, plan);

    // Persist the Razorpay refund: reversing ledger debit (only if the
    // original online payment posted a credit) + razorpay_refunds row +
    // counters.
    if (upi) {
      const [origCredit] = await tx`
        SELECT id FROM dealer_ledger
         WHERE dealer_id = ${upi.dealerId}::uuid
           AND type = 'credit'
           AND description LIKE ${"%" + upi.rzpPaymentId + "%"}
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
           WHERE d.id = ${upi.dealerId}::uuid
        `;
        const balanceAfter = parseFloat(bal!.bal) - upi.refundAmt;
        const desc = `Razorpay refund ${upi.rzpRefund.id} for ${upi.rzpPaymentId} — cancel: ${reason}`;
        const [led] = await tx`
          INSERT INTO dealer_ledger (
            dealer_id, type, amount,
            reference_id, reference_type,
            description, balance_after, performed_by,
            voucher_no, voucher_type, particulars, voucher_date
          ) VALUES (
            ${upi.dealerId}::uuid, 'debit',
            ${upi.refundAmt.toFixed(2)}::numeric,
            ${upi.rpRowId}::uuid, 'refund'::ledger_ref_type,
            ${desc}, ${balanceAfter.toFixed(2)}::numeric, ${performedBy}::uuid,
            ${"RF-" + upi.rzpRefund.id.slice(-8).toUpperCase()},
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
          ${upi.rpRowId}::uuid, ${upi.dealerId}::uuid,
          ${upi.rzpRefund.id}, ${upi.rzpPaymentId},
          ${upi.refundAmt.toFixed(2)}::numeric,
          ${upi.rzpRefund.status === "processed" ? "processed" : "pending"}::razorpay_refund_status,
          ${reason}, ${performedBy}::uuid, ${ledgerEntryId}::uuid
        )
      `;

      await tx`
        UPDATE razorpay_payments
           SET amount_refunded = amount_refunded + ${upi.refundAmt.toFixed(2)}::numeric,
               status = CASE WHEN amount_refunded + ${upi.refundAmt.toFixed(2)}::numeric >= amount - 0.001
                             THEN 'refunded'::razorpay_payment_status
                             ELSE status END,
               updated_at = now()
         WHERE id = ${upi.rpRowId}::uuid
      `;
    }
  });

  if (upi)
    return {
      paymentMode: order.payment_mode,
      refund: {
        method: "razorpay",
        amount: upi.refundAmt,
        razorpayRefundId: upi.rzpRefund.id,
        status: upi.rzpRefund.status,
      },
    };
  if (plan.to === "wallet")
    return { paymentMode: order.payment_mode, refund: { method: "wallet", amount: plan.amount } };
  if (plan.to === "ledger")
    return { paymentMode: order.payment_mode, refund: { method: "credit", amount: plan.amount } };
  // Unpaid / cash / nothing to refund (order still cancelled + stock restored)
  return { paymentMode: order.payment_mode, refund: { method: "none", amount: 0 } };
}
