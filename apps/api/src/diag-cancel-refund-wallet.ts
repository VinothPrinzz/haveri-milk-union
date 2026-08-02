// ═══════════════════════════════════════════════════════════════════════
// diag-cancel-refund-wallet.ts — one-off: cancel ONE order and refund its
// paid amount to the dealer's WALLET (available balance / store credit),
// NOT to the bank. Runs through the SAME live path the admin "Cancel →
// available balance" button uses: adminCancelOrder(orderId, reason,
// performedBy, "balance"). No duplicated stock/ledger logic.
//
// Why a diag (not the admin UI): the delivery window for this order has
// already closed, so the /orders/:id/cancel route rejects it with
// "Window closed". adminCancelOrder itself does NOT enforce the window,
// so calling it directly performs the real cancel + stock restore +
// wallet credit.
//
// For a UPI-paid order that was NOT placed on credit, confirm posted only
// a `payments` receipt and NO dealer_ledger credit (dealer-payments.ts
// FIX C). The dealer's wallet (= creditAvailable = GREATEST(0, ledger
// closing)) was therefore never touched, so this single ledger credit
// raises the wallet by exactly the paid amount — no double-count.
//
// performed_by is NULL (system correction) — dealer_ledger.performed_by is
// nullable ("null if system").
//
// USAGE (from apps/api):
//   npx tsx src/diag-cancel-refund-wallet.ts            ← dry run (inspect only)
//   npx tsx src/diag-cancel-refund-wallet.ts --apply    ← execute
// ═══════════════════════════════════════════════════════════════════════

import { pgClient } from "./lib/db.js";
import { adminCancelOrder, RefundError } from "./lib/cancel-order.js";

const APPLY = process.argv.includes("--apply");

const ORDER_ID = "63042898-e891-4d06-82dd-8fd38a7b52dc";
const REASON = "Admin cancellation — refunded to dealer wallet (store credit)";
const PERFORMED_BY = null as unknown as string; // system correction → NULL

// Dealer's wallet-facing available balance = GREATEST(0, opening + credits − debits).
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
  console.log(APPLY ? "CANCEL + REFUND TO WALLET — APPLY" : "CANCEL + REFUND TO WALLET — DRY RUN (inspect only)");
  console.log("\n────────────────────────────────────────────────────────");
  console.log(`order ${ORDER_ID}`);

  const [ord] = await pgClient`
    SELECT id::text, dealer_id::text AS "dealerId", status::text AS status,
           payment_mode::text AS "paymentMode",
           payment_reference AS "paymentReference",
           grand_total::numeric AS "grandTotal",
           delivery_date::text AS "deliveryDate"
      FROM orders WHERE id = ${ORDER_ID}::uuid
  `;
  if (!ord) { console.log("  ✗ order not found — aborting"); await pgClient.end(); return; }
  console.log(`  order: status=${ord.status} payment_mode=${ord.paymentMode} grand_total=${ord.grandTotal} delivery=${ord.deliveryDate} ref=${ord.paymentReference}`);

  if (ord.status === "cancelled") { console.log("  ✓ already cancelled — nothing to do"); await pgClient.end(); return; }
  if (!["confirmed", "dispatched", "payment_required"].includes(ord.status)) {
    console.log(`  ✗ order is '${ord.status}' — not a cancellable state; aborting`); await pgClient.end(); return;
  }

  const [rp] = await pgClient`
    SELECT id::text, status::text AS status, amount::numeric AS amount,
           amount_refunded::numeric AS "amountRefunded", razorpay_payment_id AS "rzpPaymentId"
      FROM razorpay_payments
     WHERE order_id = ${ORDER_ID}::uuid AND kind = 'order_payment' AND status = 'paid'
     ORDER BY created_at DESC LIMIT 1
  `;
  const paidRemaining = rp ? Math.max(0, parseFloat(rp.amount) - parseFloat(rp.amountRefunded)) : 0;
  console.log(`  paid razorpay_payments row: ${rp ? `${rp.rzpPaymentId} amount=${rp.amount} refunded=${rp.amountRefunded} → refundable=${paidRemaining.toFixed(2)}` : "NONE"}`);

  const before = await availableBalance(ord.dealerId);
  console.log(`  dealer wallet (available balance) BEFORE: ₹${before.toFixed(2)}`);

  if (paidRemaining <= 0.001) {
    console.log("  ⚠ no refundable online payment — 'balance' cancel would credit ₹0 (order would still cancel). Refusing in this diag; inspect manually.");
    await pgClient.end(); return;
  }

  console.log(`\n  PLAN: cancel order, restore stock, credit ₹${paidRemaining.toFixed(2)} to dealer wallet (dealer_ledger credit). No bank refund.`);

  if (!APPLY) {
    console.log("  — dry run — re-run with --apply to execute.");
    await pgClient.end(); return;
  }

  let summary;
  try {
    summary = await adminCancelOrder(ORDER_ID, REASON, PERFORMED_BY, "balance");
  } catch (err) {
    if (err instanceof RefundError) { console.log("  ✗ RefundError:", err.message); await pgClient.end(); process.exit(1); }
    throw err;
  }
  console.log("  ✓ cancelled:", JSON.stringify(summary));

  const [after] = await pgClient`
    SELECT status::text AS status, cancelled_at AS "cancelledAt",
           cancellation_reason AS "cancelReason"
      FROM orders WHERE id = ${ORDER_ID}::uuid
  `;
  console.log("  order now:", JSON.stringify(after));

  const [credit] = await pgClient`
    SELECT type::text, amount::numeric AS amount, reference_type::text AS "refType",
           voucher_type AS "voucherType", description, balance_after AS "balanceAfter", performed_by AS "performedBy"
      FROM dealer_ledger
     WHERE reference_id = ${ORDER_ID}::uuid AND type = 'credit'
     ORDER BY created_at DESC LIMIT 1
  `;
  console.log("  refund ledger credit:", JSON.stringify(credit));

  const afterBal = await availableBalance(ord.dealerId);
  console.log(`  dealer wallet (available balance) AFTER: ₹${afterBal.toFixed(2)}  (Δ +₹${(afterBal - before).toFixed(2)})`);

  await pgClient.end();
}

main().catch((err) => { console.error("\n✗ ERROR:", err); process.exit(1); });
