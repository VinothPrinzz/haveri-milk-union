// ═══════════════════════════════════════════════════════════════════════
// diag-cancel-refund-aa294b69.ts — one-off: cancel the order behind invoice
// INV-HMU-2026-AA294B69 (reason: not delivered) and refund its paid amount
// to the dealer's WALLET / available balance (store credit), NOT to the bank.
//
// Asked for by invoice number, so the order is resolved through
// invoices.invoice_number → invoices.order_id rather than hard-coded.
//
// Runs through the SAME live path the admin "Cancel → available balance"
// button uses: adminCancelOrder(orderId, reason, performedBy, "balance").
// No duplicated stock/ledger logic. adminCancelOrder does NOT enforce the
// delivery/cancel window, so this works after the route would say
// "Window closed".
//
// What "balance" does per payment_mode (see lib/cancel-order.ts):
//   • wallet → dealer_wallets.balance += what the wallet actually gave up
//              (walletDebitedForOrder, floored at grand_total) + ledger credit
//   • credit → ledger credit of grand_total (reverses the placement debit)
//   • upi    → ledger credit of the still-unrefunded captured payment, net
//              of anything already returned on the balance rail
//   • cash / unpaid / nothing left → no money moves (order still cancels)
// The dry run previews that same plan; the script REFUSES when the plan
// would credit Rs 0, so a cancel that moves no money is never done blind.
//
// Refuses 'delivered' orders (the reason is "not delivered") and anything
// not in a cancellable state.
//
// performed_by is NULL (system correction) — dealer_ledger.performed_by is
// nullable ("null if system").
//
// USAGE (from apps/api):
//   npx tsx src/diag-cancel-refund-aa294b69.ts            ← dry run (inspect only)
//   npx tsx src/diag-cancel-refund-aa294b69.ts --apply    ← execute
// ═══════════════════════════════════════════════════════════════════════

import { pgClient } from "./lib/db.js";
import { adminCancelOrder, RefundError } from "./lib/cancel-order.js";
import {
  balanceRefundedForOrder,
  refundableToBank,
  walletDebitedForOrder,
} from "./lib/refund-accounting.js";

const APPLY = process.argv.includes("--apply");

const INVOICE_NUMBER = "INV-HMU-2026-AA294B69";
const REASON = "Admin cancellation - not delivered; refunded to dealer wallet (available balance)";
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

async function walletBalance(dealerId: string): Promise<number | null> {
  const [w] = await pgClient`
    SELECT balance::numeric AS balance FROM dealer_wallets WHERE dealer_id = ${dealerId}::uuid
  `;
  return w ? parseFloat(w.balance) : null;
}

async function main() {
  console.log(APPLY
    ? "CANCEL (NOT DELIVERED) + REFUND TO WALLET — APPLY"
    : "CANCEL (NOT DELIVERED) + REFUND TO WALLET — DRY RUN (inspect only)");
  console.log("\n────────────────────────────────────────────────────────");

  const invoices = await pgClient`
    SELECT id::text, order_id::text AS "orderId", invoice_number AS "invoiceNumber",
           total_amount::numeric AS total, paid_amount::numeric AS paid,
           payment_status::text AS "payStatus"
      FROM invoices WHERE invoice_number = ${INVOICE_NUMBER}
  `;
  if (invoices.length !== 1) {
    console.log(`  ✗ expected exactly 1 invoice ${INVOICE_NUMBER}, found ${invoices.length} — aborting`);
    await pgClient.end();
    return;
  }
  const inv = invoices[0]!;
  const ORDER_ID: string = inv.orderId;
  console.log(`invoice ${INVOICE_NUMBER} (${inv.id}) → order ${ORDER_ID}`);
  console.log(`  invoice: total=${inv.total} paid=${inv.paid} status=${inv.payStatus}`);

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
  if (ord.status === "delivered") {
    console.log("  ✗ order is marked 'delivered' — contradicts 'not delivered'; aborting. Inspect manually.");
    await pgClient.end();
    return;
  }
  if (!["confirmed", "dispatched", "payment_required"].includes(ord.status)) {
    console.log(`  ✗ order is '${ord.status}' — not a cancellable state; aborting`);
    await pgClient.end();
    return;
  }

  // ── Preview the "balance" plan exactly as adminCancelOrder computes it ──
  const grandTotal = Math.max(0, parseFloat(ord.grandTotal));
  const [rp] = await pgClient`
    SELECT id::text, status::text AS status, amount::numeric AS amount,
           amount_refunded::numeric AS "amountRefunded", razorpay_payment_id AS "rzpPaymentId"
      FROM razorpay_payments
     WHERE order_id = ${ORDER_ID}::uuid AND kind = 'order_payment'
       AND status IN ('paid', 'refunded')
     ORDER BY (amount - amount_refunded) DESC, created_at DESC
     LIMIT 1
  `;
  const paidRemaining = rp ? Math.max(0, parseFloat(rp.amount) - parseFloat(rp.amountRefunded)) : 0;
  const alreadyOnBalance = await balanceRefundedForOrder(pgClient, ORDER_ID);
  const refundable = Math.min(refundableToBank(paidRemaining, alreadyOnBalance), grandTotal);
  console.log(`  razorpay payment: ${rp ? `${rp.rzpPaymentId} status=${rp.status} amount=${rp.amount} refunded=${rp.amountRefunded}` : "NONE"}`);
  console.log(`  already returned on the balance rail: Rs ${alreadyOnBalance.toFixed(2)}`);

  let expected = 0;
  let rail = "none";
  if (rp && refundable <= 0.001) {
    rail = "none (online payment already refunded in full)";
  } else if (ord.paymentMode === "wallet") {
    const walletDebited = await walletDebitedForOrder(pgClient, ORDER_ID);
    console.log(`  wallet actually debited for this order: Rs ${walletDebited.toFixed(2)}`);
    if (walletDebited > 0.001) { expected = Math.min(walletDebited, grandTotal); rail = "wallet (dealer_wallets + ledger credit)"; }
    else rail = "none (wallet was never debited)";
  } else if (ord.paymentMode === "credit") {
    expected = grandTotal; rail = "ledger credit (reverses placement debit)";
  } else if (rp && refundable > 0.001) {
    expected = refundable; rail = "ledger credit (store credit for online payment)";
  } else {
    rail = "none (unpaid / cash)";
  }

  const beforeAvail = await availableBalance(ord.dealerId);
  const beforeWallet = await walletBalance(ord.dealerId);
  console.log(`  dealer available balance BEFORE: Rs ${beforeAvail.toFixed(2)}`);
  console.log(`  dealer_wallets.balance BEFORE:   ${beforeWallet === null ? "no wallet row" : `Rs ${beforeWallet.toFixed(2)}`}`);

  if (expected <= 0.001) {
    console.log(`\n  ⚠ plan resolves to ${rail} — a 'balance' cancel would refund Rs 0. Refusing; inspect manually.`);
    await pgClient.end();
    return;
  }
  if (rail.startsWith("wallet") && beforeWallet === null) {
    console.log("\n  ✗ wallet order but dealer has no dealer_wallets row — the wallet credit would fail; aborting.");
    await pgClient.end();
    return;
  }

  console.log(`\n  PLAN: cancel order ("${REASON}"), restore stock, refund Rs ${expected.toFixed(2)} → ${rail}. No bank refund.`);

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
  if (Math.abs(summary.refund.amount - expected) > 0.01) {
    console.log(`  ⚠ UNEXPECTED: refunded Rs ${summary.refund.amount} but preview said Rs ${expected.toFixed(2)} — verify!`);
  }

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

  const [invAfter] = await pgClient`
    SELECT invoice_number, total_amount::numeric AS total,
           paid_amount::numeric AS paid, payment_status::text AS "payStatus"
      FROM invoices WHERE order_id = ${ORDER_ID}::uuid
  `;
  console.log("  invoice now:", JSON.stringify(invAfter));

  const afterAvail = await availableBalance(ord.dealerId);
  const afterWallet = await walletBalance(ord.dealerId);
  console.log(`  dealer available balance AFTER: Rs ${afterAvail.toFixed(2)}  (delta +Rs ${(afterAvail - beforeAvail).toFixed(2)})`);
  if (beforeWallet !== null && afterWallet !== null) {
    console.log(`  dealer_wallets.balance AFTER:   Rs ${afterWallet.toFixed(2)}  (delta +Rs ${(afterWallet - beforeWallet).toFixed(2)})`);
  }

  await pgClient.end();
}

main().catch((err) => {
  console.error("\n✗ ERROR:", err);
  process.exit(1);
});
