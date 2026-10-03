// ═══════════════════════════════════════════════════════════════════════
// diag-cancel-066cc05d-refunded.ts — one-off: cancel ONE order whose paid
// amount was ALREADY refunded to the dealer's BANK via Razorpay, so the
// cancel must move NO money — just flip the order to cancelled and restore
// stock. Runs through the SAME live path the admin cancel uses:
// adminCancelOrder(orderId, reason, performedBy, "balance").
//
// Why "balance" and not "razorpay": the order's razorpay_payments row is
// already status='refunded' with amount_refunded == amount, so
// paidRemaining == 0 → canBankRefund == false. In adminCancelOrder the
// "balance" branch for a UPI-paid order only credits store credit when
// canBankRefund is true; with it false the plan resolves to { to: "none" }.
// Net effect: UPDATE orders → cancelled + restoreOrderStock, and NO
// dealer_ledger credit, NO wallet credit, NO Razorpay call. (Passing
// "razorpay" here would instead raise RefundError — nothing left to refund.)
//
// Why a diag (not the admin UI): the delivery window (2026-07-02) closed
// two weeks ago, so the /orders/:id/cancel route rejects it with "Window
// closed". adminCancelOrder itself does NOT enforce the window.
//
// Stock note: restoreOrderStock only bumps the vestigial products.stock
// running counter (guarded by orders.stock_deducted so it can't double-
// restore). Post-FGS-migration, sellable availability is derived from the
// day-aware FGS daily model, not this counter, so restoring a past-dated
// order does not inflate today's availability.
//
// performed_by is NULL (system correction) and is unused on the "none"
// balance plan anyway.
//
// USAGE (from apps/api):
//   npx tsx src/diag-cancel-066cc05d-refunded.ts            ← dry run (inspect only)
//   npx tsx src/diag-cancel-066cc05d-refunded.ts --apply    ← execute
// ═══════════════════════════════════════════════════════════════════════

import { pgClient } from "./lib/db.js";
import { adminCancelOrder, RefundError } from "./lib/cancel-order.js";

const APPLY = process.argv.includes("--apply");

const ORDER_ID = "066cc05d-e8f1-4fcf-8656-76960aed147b";
const REASON = "Admin cancellation — order already refunded to bank (Razorpay rfnd_T8dEGWcwSrHQ0O)";
const PERFORMED_BY = null as unknown as string; // system correction → NULL

async function main() {
  console.log(APPLY ? "CANCEL ALREADY-REFUNDED ORDER — APPLY" : "CANCEL ALREADY-REFUNDED ORDER — DRY RUN (inspect only)");
  console.log("\n────────────────────────────────────────────────────────");
  console.log(`order ${ORDER_ID}`);

  const [ord] = await pgClient`
    SELECT id::text, dealer_id::text AS "dealerId", status::text AS status,
           payment_mode::text AS "paymentMode", payment_reference AS "paymentReference",
           grand_total::numeric AS "grandTotal", delivery_date::text AS "deliveryDate"
      FROM orders WHERE id = ${ORDER_ID}::uuid
  `;
  if (!ord) { console.log("  ✗ order not found — aborting"); await pgClient.end(); return; }
  console.log(`  order: status=${ord.status} payment_mode=${ord.paymentMode} grand_total=${ord.grandTotal} delivery=${ord.deliveryDate} ref=${ord.paymentReference}`);

  if (ord.status === "cancelled") { console.log("  ✓ already cancelled — nothing to do"); await pgClient.end(); return; }
  if (!["confirmed", "dispatched", "payment_required"].includes(ord.status)) {
    console.log(`  ✗ order is '${ord.status}' — not a cancellable state; aborting`); await pgClient.end(); return;
  }

  // Guard 1: this must be a UPI-paid order. wallet/credit orders would get a
  // (double) store-credit on the "balance" plan even though already refunded,
  // so refuse them here — they aren't this scenario.
  if (ord.paymentMode !== "upi") {
    console.log(`  ✗ payment_mode='${ord.paymentMode}' (expected 'upi') — refusing; inspect manually`); await pgClient.end(); return;
  }

  // Guard 2: the online payment must be FULLY refunded already (premise of
  // this fix). If anything is still refundable we must NOT silently cancel.
  const [rp] = await pgClient`
    SELECT id::text, status::text AS status, amount::numeric AS amount,
           amount_refunded::numeric AS "amountRefunded", razorpay_payment_id AS "rzpPaymentId"
      FROM razorpay_payments
     WHERE order_id = ${ORDER_ID}::uuid AND kind = 'order_payment'
     ORDER BY created_at DESC LIMIT 1
  `;
  if (!rp) { console.log("  ✗ no order_payment razorpay_payments row — refusing"); await pgClient.end(); return; }
  const paidRemaining = Math.max(0, parseFloat(rp.amount) - parseFloat(rp.amountRefunded));
  console.log(`  razorpay_payments: status=${rp.status} amount=${rp.amount} refunded=${rp.amountRefunded} → refundable=${paidRemaining.toFixed(2)} (${rp.rzpPaymentId})`);
  if (paidRemaining > 0.001 || rp.status !== "refunded") {
    console.log("  ✗ payment is NOT fully refunded — premise 'was refunded' not met; refusing. Inspect manually.");
    await pgClient.end(); return;
  }

  // Guard 3: confirm a processed Razorpay refund actually exists on record.
  const [ref] = await pgClient`
    SELECT razorpay_refund_id AS "rzpRefundId", amount::numeric AS amount, status::text AS status
      FROM razorpay_refunds
     WHERE razorpay_payment_row = ${rp.id}::uuid
     ORDER BY created_at DESC LIMIT 1
  `;
  if (!ref || ref.status !== "processed") {
    console.log(`  ✗ no processed razorpay_refunds row (got ${ref ? ref.status : "none"}) — refusing`); await pgClient.end(); return;
  }
  console.log(`  razorpay_refunds: ${ref.rzpRefundId} amount=${ref.amount} status=${ref.status}`);

  console.log(`\n  PLAN: cancel order + restore stock. NO money movement (already refunded to bank). refundMethod="balance" → plan { to: "none" }.`);

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
  if (summary.refund.method !== "none" || summary.refund.amount !== 0) {
    console.log("  ⚠ UNEXPECTED: refund summary is not none/0 — verify no extra money was moved!");
  }

  const [after] = await pgClient`
    SELECT status::text AS status, stock_deducted AS "stockDeducted",
           cancelled_at AS "cancelledAt", cancellation_reason AS "cancelReason"
      FROM orders WHERE id = ${ORDER_ID}::uuid
  `;
  console.log("  order now:", JSON.stringify(after));

  // Confirm no NEW ledger/refund rows were written for this order.
  const [ledCount] = await pgClient`
    SELECT count(*)::int AS n FROM dealer_ledger WHERE reference_id = ${ORDER_ID}::uuid
  `;
  console.log(`  dealer_ledger rows for this order after cancel: ${ledCount!.n} (expected 0)`);

  await pgClient.end();
}

main().catch((err) => { console.error("\n✗ ERROR:", err); process.exit(1); });
