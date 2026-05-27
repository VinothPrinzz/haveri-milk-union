import { pgClient } from "./db.js";

/**
 * Cancels an order and reverses its financial effect (wallet refund or
 * credit-ledger reversal). MUST run inside a transaction — pass the tx
 * client. Mirrors PATCH /cancellations/:id/approve exactly.
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