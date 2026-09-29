import { pgClient } from "./db.js";
import { restoreOrderStock } from "./stock-check.js";
import { isRazorpayConfigured, createRazorpayRefund } from "./razorpay-client.js";
import { refreshInvoiceSettlement } from "./invoice-settlement.js";
import {
  balanceRefundedForOrder,
  refundableToBank,
  walletDebitedForOrder,
} from "./refund-accounting.js";

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
    /** Why nothing moved, when method is "none" for a paid order. */
    note?: string;
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
         ${'Cancellation credit for order ' + orderId},
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
  //
  // 'refunded' rows count too: a payment already handed back in full still
  // proves money changed hands, which is what tells the cancel below to pass
  // quietly instead of rejecting the operator's refund destination. The
  // ordering keeps a still-refundable payment ahead of a spent one.
  const [rp] = await pgClient`
    SELECT id, dealer_id::text AS "dealerId",
           amount::numeric AS amount, amount_refunded::numeric AS "amountRefunded",
           razorpay_payment_id AS "rzpPaymentId"
      FROM razorpay_payments
     WHERE order_id = ${orderId} AND kind = 'order_payment'
       AND status IN ('paid', 'refunded')
     ORDER BY (amount - amount_refunded) DESC, created_at DESC
     LIMIT 1
  `;
  const paidRemaining = rp
    ? Math.max(0, parseFloat(rp.amount) - parseFloat(rp.amountRefunded))
    : 0;

  // ── How much this cancel is still allowed to put back ────────────────
  // grand_total is the order's CURRENT value. A downward "modify indent"
  // has already handed the difference back — and when it went to the
  // available balance or the wallet, the gateway's amount_refunded counter
  // (and therefore paidRemaining) never moved. Reading paidRemaining alone
  // then refunds the same rupees a second time on cancel: order
  // 75b8e03f-c197-4568-ba16-b48f297f94ea (2026-08-29) was modified to zero
  // with Rs 1,323.88 credited to the balance and then cancelled to the bank
  // for another Rs 1,323.88 against a single Rs 1,323.88 payment.
  //
  // Netting off what the balance rail has already returned closes it in both
  // directions: an order taken to zero has nothing left to refund, and one
  // taken from Rs 1,000 to Rs 600 can still refund Rs 600 whichever rail the
  // first Rs 400 went down. grand_total is kept in the floor as an
  // independent check, since a modify lowers it by exactly what it refunded.
  const refundable = Math.min(
    refundableToBank(paidRemaining, await balanceRefundedForOrder(pgClient, orderId)),
    Math.max(0, grandTotal),
  );
  const canBankRefund = !!rp && refundable > 0.001;

  // The order took an online payment, but a modify has already returned all
  // of it. The indent still needs cancelling, so cancel it and refund
  // nothing rather than rejecting the operator's choice of destination.
  const alreadyRefunded = !!rp && refundable <= 0.001;

  // ── Resolve the effective refund method ──
  let method: RefundMethod | "none";
  if (alreadyRefunded) {
    // Nothing is owed on either rail; the destination choice is moot.
    method = "none";
  } else if (refundMethod === "razorpay") {
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
        "Razorpay is not configured, so this cannot be refunded to a bank account. Cancel aborted.",
      );
    }
    if (!rp!.rzpPaymentId) {
      throw new RefundError(
        "This order's payment has no Razorpay payment id, so it cannot be refunded to a bank account. Cancel aborted.",
      );
    }
    let rzpRefund: { id: string; status: string };
    try {
      rzpRefund = await createRazorpayRefund({
        paymentId: rp!.rzpPaymentId,
        amountInRupees: refundable,
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
      refundAmt: refundable,
      rzpRefund,
    };
  }

  // ── Balance path: decide what (if anything) to credit back ──
  let plan: BalancePlan = { to: "none" };
  // A wallet-mode order whose wallet was never actually debited. Tracked so
  // the response can say so in words: an operator who just chose a refund
  // destination and saw nothing move needs to know why.
  let walletNeverDebited = false;
  if (method === "balance") {
    if (order.payment_mode === "wallet") {
      // Size the reversal from what the wallet ACTUALLY gave up, never from
      // grand_total. payment_mode = 'wallet' is an intention: prod carries
      // wallet-mode orders that never debited the wallet, and refunding
      // grand_total on one of those invents money the union never took —
      // the same phantom-credit trap the direct-sale rail documents in
      // lib/direct-sale-money.ts. A downward modify is already netted off
      // by the ledger, so grand_total only survives as an independent
      // floor (it drops by exactly what a modify handed back), mirroring
      // the bank ceiling computed above.
      const walletDebited = await walletDebitedForOrder(pgClient, orderId);
      if (walletDebited > 0.001) {
        plan = { to: "wallet", amount: Math.min(walletDebited, Math.max(0, grandTotal)) };
      } else {
        plan = { to: "none" };
        walletNeverDebited = true;
      }
    } else if (order.payment_mode === "credit") {
      plan = { to: "ledger", amount: grandTotal };
    } else if (canBankRefund) {
      // Online-paid order, but the admin chose store credit over a bank
      // refund — credit what is still unrefunded to the available balance.
      plan = { to: "ledger", amount: refundable };
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
        const desc = `Razorpay refund ${upi.rzpRefund.id} for ${upi.rzpPaymentId}, cancel: ${reason}`;
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

  // The invoice was minted when the order was confirmed and still carries the
  // settlement as of that moment. Now that the money has gone back — to the
  // bank, the wallet or the balance — re-derive it, or the invoice would keep
  // reading "paid" for an order the dealer no longer owes anything on. Runs
  // after commit and never throws; the cancel itself is already done.
  await refreshInvoiceSettlement(orderId);

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
  // Unpaid / cash / nothing left to refund (order still cancelled + stock
  // restored). Spell out the "already refunded" case — an operator who just
  // picked a refund destination needs to know why no money moved.
  return {
    paymentMode: order.payment_mode,
    refund: {
      method: "none",
      amount: 0,
      ...(alreadyRefunded
        ? {
            note:
              "This indent had already been refunded in full by an earlier change to it, " +
              "so cancelling it did not refund anything again.",
          }
        : walletNeverDebited
          ? {
              note:
                "This indent is marked as a wallet order but no money was ever taken " +
                "from the dealer's wallet for it, so there is nothing to refund. " +
                "The indent has been cancelled and the stock released.",
            }
          : {}),
    },
  };
}
