// ═══════════════════════════════════════════════════════════════════════
// diag-cancel-refund-8578ac56.ts — one-off: cancel order
// 8578ac56-56d2-4f5f-9666-e0b7956a06c8 (dealer SHARADA GULANNANAVR, S217)
// and refund its paid amount to the dealer's available balance (store
// credit / "wallet" in dealer-facing words), NOT to the bank. The order was
// confirmed but never dispatched.
//
// Asked for by invoice id 1b28f22c-9781-438e-8b09-eb2a474b6c10
// (INV-HMU-2026-8578AC56) — that is this order's invoice, not an order id,
// so the cancel targets the order it points at.
//
// Runs through the SAME live path the admin "Cancel → available balance"
// button uses: adminCancelOrder(orderId, reason, performedBy, "balance").
//
// Verified state (read-only inspect, 2026-09-01): status='confirmed',
// payment_mode='upi', grand_total=Rs 882.47, delivery_date=2026-08-30,
// dispatched_at IS NULL, stock_deducted=true, one captured
// razorpay_payments row (pay_TVyvro7oeJx2Mi, paid, amount_refunded=0 →
// fully refundable), NO dealer_ledger rows referencing the order (no
// placement debit and nothing already handed back, so no double refund and
// no phantom-credit trap), no razorpay_refunds, invoice paid 882.47/882.47.
//
// For this UPI-paid order the "balance" plan resolves to
//   { to:"ledger", amount: refundable = 882.47 }
// → one dealer_ledger credit (voucher 'Adjustment') raising the available
//   balance from Rs 0.00 → Rs 882.47, plus the stock restore. NO Razorpay
//   refund is issued (the money stays with the union as store credit), so
//   the captured UPI payment is left intact at the gateway. The invoice
//   settlement is re-derived after commit by adminCancelOrder.
//
// performed_by is NULL (system correction) — dealer_ledger.performed_by is
// nullable ("null if system").
//
// USAGE (from apps/api):
//   npx tsx src/diag-cancel-refund-8578ac56.ts            ← dry run (inspect only)
//   npx tsx src/diag-cancel-refund-8578ac56.ts --apply    ← execute
// ═══════════════════════════════════════════════════════════════════════

import { pgClient } from "./lib/db.js";
import { adminCancelOrder, RefundError } from "./lib/cancel-order.js";
import { balanceRefundedForOrder } from "./lib/refund-accounting.js";

const APPLY = process.argv.includes("--apply");

const ORDER_ID = "8578ac56-56d2-4f5f-9666-e0b7956a06c8";
const INVOICE_ID = "1b28f22c-9781-438e-8b09-eb2a474b6c10";
const REASON = "Admin cancellation - not dispatched; refunded to available balance (store credit)";
const PERFORMED_BY = null as unknown as string; // system correction → NULL

// Dealer's available balance = GREATEST(0, opening + credits − debits).
async function availableBalance(dealerId: string): Promise<number> {
  const [row] = await pgClient`
    SELECT GREATEST(0,
             COALESCE(d.opening_balance, 0)
             + COALESCE((SELECT SUM(CASE WHEN dl.type='credit' THEN dl.amount
                                         WHEN dl.type='debit'  THEN -dl.amount END)
                          FROM dealer_ledger dl
                         WHERE dl.dealer_id = d.id
                           AND COALESCE(dl.voucher_type,'') <> 'Opening'), 0)
           )::numeric AS avail
      FROM dealers d WHERE d.id = ${dealerId}::uuid
  `;
  return parseFloat(row!.avail);
}

async function main() {
  console.log(APPLY
    ? "CANCEL + REFUND TO AVAILABLE BALANCE — APPLY"
    : "CANCEL + REFUND TO AVAILABLE BALANCE — DRY RUN (inspect only)");
  console.log("\n────────────────────────────────────────────────────────");
  console.log(`invoice ${INVOICE_ID} → order ${ORDER_ID}`);

  const [ord] = await pgClient`
    SELECT o.id::text, o.dealer_id::text AS "dealerId", o.status::text AS status,
           o.payment_mode::text AS "paymentMode",
           o.payment_reference AS "paymentReference",
           o.grand_total::numeric AS "grandTotal",
           o.delivery_date::text AS "deliveryDate",
           o.dispatched_at AS "dispatchedAt", o.stock_deducted AS "stockDeducted",
           d.name AS "dealerName", d.code AS "dealerCode"
      FROM orders o JOIN dealers d ON d.id = o.dealer_id
     WHERE o.id = ${ORDER_ID}::uuid
  `;
  if (!ord) {
    console.log("  ✗ order not found — aborting");
    await pgClient.end();
    return;
  }
  console.log(`  dealer: ${ord.dealerName} (${ord.dealerCode})`);
  console.log(`  order: status=${ord.status} payment_mode=${ord.paymentMode} grand_total=${ord.grandTotal} delivery=${ord.deliveryDate} dispatched_at=${ord.dispatchedAt} stock_deducted=${ord.stockDeducted} ref=${ord.paymentReference}`);

  if (ord.status === "cancelled") {
    console.log("  ✓ already cancelled — nothing to do");
    await pgClient.end();
    return;
  }
  if (ord.dispatchedAt) {
    console.log("  ✗ order HAS been dispatched — aborting (this script is only for undispatched orders)");
    await pgClient.end();
    return;
  }
  if (!["confirmed", "payment_required"].includes(ord.status)) {
    console.log(`  ✗ order is '${ord.status}' — not a cancellable state here; aborting`);
    await pgClient.end();
    return;
  }

  const [rp] = await pgClient`
    SELECT id::text, status::text AS status, amount::numeric AS amount,
           amount_refunded::numeric AS "amountRefunded", razorpay_payment_id AS "rzpPaymentId"
      FROM razorpay_payments
     WHERE order_id = ${ORDER_ID}::uuid AND kind = 'order_payment' AND status = 'paid'
     ORDER BY created_at DESC LIMIT 1
  `;
  const paidRemaining = rp ? Math.max(0, parseFloat(rp.amount) - parseFloat(rp.amountRefunded)) : 0;
  console.log(`  paid razorpay_payments row: ${rp ? `${rp.rzpPaymentId} amount=${rp.amount} refunded=${rp.amountRefunded} → gateway-refundable=${paidRemaining.toFixed(2)}` : "NONE"}`);

  // Already handed back on the balance rail (a downward modify, or an
  // earlier cancel-to-credit). Netted off so nothing is refunded twice.
  const alreadyOnBalance = await balanceRefundedForOrder(pgClient, ORDER_ID);
  const credit = Math.min(
    Math.max(0, paidRemaining - alreadyOnBalance),
    Math.max(0, parseFloat(ord.grandTotal)),
  );
  console.log(`  already returned on the balance rail: Rs ${alreadyOnBalance.toFixed(2)}`);

  const before = await availableBalance(ord.dealerId);
  console.log(`  dealer available balance BEFORE: Rs ${before.toFixed(2)}`);

  if (credit <= 0.001) {
    console.log("  ⚠ nothing left to refund — a 'balance' cancel would credit Rs 0 (the order would still cancel). Refusing in this diag; inspect manually.");
    await pgClient.end();
    return;
  }

  console.log(`\n  PLAN: cancel order, restore stock, credit Rs ${credit.toFixed(2)} to the dealer's available balance (dealer_ledger credit). No bank refund.`);

  if (!APPLY) {
    console.log("  — dry run — re-run with --apply to execute.");
    await pgClient.end();
    return;
  }

  let summary;
  try {
    summary = await adminCancelOrder(ORDER_ID, REASON, PERFORMED_BY, "balance");
  } catch (err) {
    if (err instanceof RefundError) {
      console.log("  ✗ RefundError:", err.message);
      await pgClient.end();
      process.exit(1);
    }
    throw err;
  }
  console.log("  ✓ cancelled:", JSON.stringify(summary));

  const [after] = await pgClient`
    SELECT status::text AS status, cancelled_at AS "cancelledAt",
           cancellation_reason AS "cancelReason", stock_deducted AS "stockDeducted"
      FROM orders WHERE id = ${ORDER_ID}::uuid
  `;
  console.log("  order now:", JSON.stringify(after));

  const [led] = await pgClient`
    SELECT type::text, amount::numeric AS amount, reference_type::text AS "refType",
           voucher_type AS "voucherType", description,
           balance_after::numeric AS "balanceAfter", performed_by AS "performedBy"
      FROM dealer_ledger
     WHERE reference_id = ${ORDER_ID}::uuid AND type = 'credit'
     ORDER BY created_at DESC LIMIT 1
  `;
  console.log("  refund ledger credit:", JSON.stringify(led));

  const [inv] = await pgClient`
    SELECT invoice_number, total_amount::numeric AS total,
           paid_amount::numeric AS paid, payment_status::text AS "payStatus"
      FROM invoices WHERE order_id = ${ORDER_ID}::uuid
  `;
  console.log("  invoice now:", JSON.stringify(inv));

  const [gw] = await pgClient`
    SELECT razorpay_payment_id AS "rzpPaymentId", status::text AS status,
           amount::numeric AS amount, amount_refunded::numeric AS "amountRefunded"
      FROM razorpay_payments WHERE order_id = ${ORDER_ID}::uuid
  `;
  console.log("  gateway payment (should be untouched):", JSON.stringify(gw));

  const afterBal = await availableBalance(ord.dealerId);
  console.log(`  dealer available balance AFTER: Rs ${afterBal.toFixed(2)}  (delta +Rs ${(afterBal - before).toFixed(2)})`);

  await pgClient.end();
}

main().catch((err) => {
  console.error("\n✗ ERROR:", err);
  process.exit(1);
});
