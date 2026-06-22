import { pgClient } from "./db.js";
import { restoreOrderStock } from "./stock-check.js";
import { isRazorpayConfigured, createRazorpayRefund } from "./razorpay-client.js";

/**
 * Raised when an order can't be auto-refunded (e.g. a UPI order whose
 * gateway refund is impossible because Razorpay isn't configured or the
 * payment row has no gateway id). The admin-cancel route maps this to a
 * 409 so the operator knows the cancel was NOT performed.
 */
export class RefundError extends Error {
  statusCode = 409;
  constructor(message: string) {
    super(message);
    this.name = "RefundError";
  }
}

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
 * Cancels an order and reverses its effects: the financial reversal
 * (wallet refund or credit-ledger reversal) AND the product-stock restore
 * (the inverse of the deduction done at confirm). MUST run inside a
 * transaction — pass the tx client. Wraps the DB-only reversals shared by
 * every cancel path; UPI gateway refunds are layered on by
 * adminCancelOrder, which calls Razorpay outside the transaction first.
 */
export async function cancelOrderWithReversal(
  tx: typeof pgClient,
  orderId: string,
  reason: string,
  performedBy: string,
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

  if (order.payment_mode === "wallet") {
    const [wallet] = await tx`
      UPDATE dealer_wallets
         SET balance = balance + ${order.grand_total}::numeric, updated_at = now()
       WHERE dealer_id = ${order.dealer_id}
      RETURNING balance
    `;
    await tx`
      INSERT INTO dealer_ledger
        (dealer_id, type, amount, reference_id, reference_type,
         description, balance_after, performed_by)
      VALUES
        (${order.dealer_id}, 'credit', ${order.grand_total}::numeric,
         ${orderId}, 'refund', 'Cancellation refund',
         ${wallet!.balance}::numeric, ${performedBy})
    `;
  }

  if (order.payment_mode === "credit") {
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
    const balanceAfter = parseFloat(bal!.bal) + parseFloat(order.grand_total);
    await tx`
      INSERT INTO dealer_ledger
        (dealer_id, type, amount, reference_id, reference_type,
         voucher_type, voucher_date, description, balance_after, performed_by)
      VALUES
        (${order.dealer_id}, 'credit',
         ${parseFloat(order.grand_total).toFixed(2)}::numeric,
         ${orderId}, 'order', 'Adjustment', now()::date,
         ${'Cancel credit order ' + orderId},
         ${balanceAfter.toFixed(2)}::numeric, ${performedBy})
    `;
  }
}

/**
 * Admin-side cancel for an indent, with the right auto-refund for the
 * order's payment mode:
 *   • wallet → wallet balance credited (handled by cancelOrderWithReversal)
 *   • credit → credit-ledger reversed   (handled by cancelOrderWithReversal)
 *   • upi    → Razorpay refund issued for the unrefunded balance of the
 *              order's paid online payment, recorded as a razorpay_refunds
 *              row + (when the original online payment posted a ledger
 *              credit) a reversing ledger debit.
 *   • cash / complimentary / upi-without-a-gateway-payment → nothing to
 *              refund (the order is still cancelled + stock restored).
 *
 * The Razorpay call is made BEFORE the DB transaction is opened — a gateway
 * failure then leaves nothing half-written and throws (no cancel happens).
 * Returns a summary the API surfaces to the operator.
 */
export async function adminCancelOrder(
  orderId: string,
  reason: string,
  performedBy: string,
): Promise<RefundSummary> {
  const [order] = await pgClient`
    SELECT payment_mode, grand_total, dealer_id
      FROM orders WHERE id = ${orderId} LIMIT 1
  `;
  if (!order) throw new Error("Order not found");
  const grandTotal = parseFloat(order.grand_total);

  // ── UPI: resolve the gateway refund up front (outside the tx) ──
  let upi:
    | { rpRowId: string; rzpPaymentId: string; dealerId: string; refundAmt: number;
        rzpRefund: { id: string; status: string } }
    | null = null;

  if (order.payment_mode === "upi") {
    const [rp] = await pgClient`
      SELECT id, dealer_id::text AS "dealerId", status::text AS status,
             amount::numeric AS amount, amount_refunded::numeric AS "amountRefunded",
             razorpay_payment_id AS "rzpPaymentId"
        FROM razorpay_payments
       WHERE order_id = ${orderId} AND kind = 'order_payment' AND status = 'paid'
       ORDER BY created_at DESC
       LIMIT 1
    `;
    if (rp) {
      if (!isRazorpayConfigured()) {
        throw new RefundError(
          "This UPI order has an online payment but Razorpay is not configured — cannot auto-refund. Cancel aborted.",
        );
      }
      if (!rp.rzpPaymentId) {
        throw new RefundError(
          "This UPI order's payment has no Razorpay payment id — cannot auto-refund. Cancel aborted.",
        );
      }
      const remaining = parseFloat(rp.amount) - parseFloat(rp.amountRefunded);
      if (remaining > 0.001) {
        let rzpRefund: { id: string; status: string };
        try {
          rzpRefund = await createRazorpayRefund({
            paymentId: rp.rzpPaymentId,
            amountInRupees: remaining,
            notes: { reason, orderId, dealerId: rp.dealerId },
          });
        } catch (err: any) {
          throw new RefundError(
            err?.message ?? "Razorpay rejected the refund. Cancel aborted.",
          );
        }
        upi = {
          rpRowId: rp.id,
          rzpPaymentId: rp.rzpPaymentId,
          dealerId: rp.dealerId,
          refundAmt: remaining,
          rzpRefund,
        };
      }
    }
  }

  await pgClient.begin(async (_tx) => {
    const tx = _tx as unknown as typeof pgClient;

    // Cancel + stock restore + wallet/credit reversal.
    await cancelOrderWithReversal(tx, orderId, reason, performedBy);

    // Persist the UPI refund: reversing ledger debit (only if the original
    // online payment posted a credit) + razorpay_refunds row + counters.
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

  if (order.payment_mode === "wallet")
    return { paymentMode: order.payment_mode, refund: { method: "wallet", amount: grandTotal } };
  if (order.payment_mode === "credit")
    return { paymentMode: order.payment_mode, refund: { method: "credit", amount: grandTotal } };
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
  // cash / complimentary / upi with no captured gateway payment
  return { paymentMode: order.payment_mode, refund: { method: "none", amount: 0 } };
}