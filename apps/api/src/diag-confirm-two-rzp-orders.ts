// ═══════════════════════════════════════════════════════════════════════
// diag-confirm-two-rzp-orders.ts — one-off: reconcile exactly the two
// dealer-reported Razorpay payments below through the SAME live path as
// the webhook / reconcile sweep (ensureCaptured-style verify against
// Razorpay, then applyPaidPayment). No duplicated ledger/stock/invoice
// logic, and scoped ONLY to these two razorpay_payments rows — the repo
// has ~64 other stuck created/attempted/failed rows going back a week
// that this deliberately does NOT touch.
//
// Both target orders are currently 'cancelled' with cancellation_reason
// = AUTO_DISCARD_REASON ("Online payment not completed before window
// close") — confirmPaidOrder() revives exactly this state once the
// payment is verified captured.
//
// USAGE (from apps/api):
//   npx tsx src/diag-confirm-two-rzp-orders.ts            ← dry run (verify only)
//   npx tsx src/diag-confirm-two-rzp-orders.ts --apply    ← execute
// ═══════════════════════════════════════════════════════════════════════

import { pgClient } from "./lib/db.js";
import { fetchRazorpayPayment, captureRazorpayPayment } from "./lib/razorpay-client.js";
import { applyPaidPayment } from "./routes/dealer-payments.js";

const APPLY = process.argv.includes("--apply");

const TARGETS = [
  { rzpOrderId: "order_TIUd7a7y9y4ulT", rzpPaymentId: "pay_TIUdM6lQvH9uSn" },
];

async function main() {
  console.log(APPLY ? "CONFIRM TWO ORDERS — APPLY" : "CONFIRM TWO ORDERS — DRY RUN (verify only)");

  for (const t of TARGETS) {
    console.log("\n────────────────────────────────────────────────────────");
    console.log(`rzp order ${t.rzpOrderId}  /  rzp payment ${t.rzpPaymentId}`);

    const [row] = await pgClient`
      SELECT id::text, dealer_id::text AS "dealerId", order_id::text AS "orderId",
             kind::text, status::text, amount::numeric AS amount,
             razorpay_payment_id AS "rzpPaymentId"
        FROM razorpay_payments
       WHERE razorpay_order_id = ${t.rzpOrderId}
    `;
    if (!row) { console.log("  ✗ no razorpay_payments row for this rzp order id — skipping"); continue; }
    console.log(`  DB row: status=${row.status} kind=${row.kind} amount=${row.amount} order=${row.orderId}`);

    if (row.status === "paid") {
      console.log("  already 'paid' in DB — just re-running confirm via applyPaidPayment");
      if (APPLY) {
        const applied = await applyPaidPayment(row.id);
        console.log("  ✓ applied:", JSON.stringify(applied));
      } else {
        console.log("  (dry run — would call applyPaidPayment)");
      }
      continue;
    }
    if (row.status !== "created" && row.status !== "attempted" && row.status !== "failed") {
      console.log(`  ✗ unexpected status '${row.status}' — refusing, inspect manually`);
      continue;
    }

    const [ord] = await pgClient`
      SELECT status::text AS status, cancellation_reason AS "cancelReason",
             grand_total::numeric AS "grandTotal"
        FROM orders WHERE id = ${row.orderId}::uuid
    `;
    console.log(`  order: status=${ord?.status} grand_total=${ord?.grandTotal} cancel_reason=${ord?.cancelReason}`);

    const expectedPaise = Math.round(parseFloat(row.amount) * 100);

    let payment;
    try {
      payment = await fetchRazorpayPayment(t.rzpPaymentId);
    } catch (err) {
      console.log("  ✗ could not fetch payment from Razorpay:", err instanceof Error ? err.message : err);
      continue;
    }
    console.log(`  Razorpay says: status=${payment.status} order_id=${payment.order_id} amount=${payment.amount}`);

    if (payment.order_id && payment.order_id !== t.rzpOrderId) {
      console.log("  ✗ payment belongs to a different order — refusing"); continue;
    }
    if (payment.amount !== expectedPaise) {
      console.log(`  ✗ amount mismatch: razorpay ${payment.amount} paise vs expected ${expectedPaise} — refusing`); continue;
    }

    let capturedId = payment.status === "captured" ? t.rzpPaymentId : null;
    if (!capturedId && payment.status === "authorized") {
      console.log("  payment is only 'authorized' — capturing now");
      if (APPLY) {
        const cap = await captureRazorpayPayment(t.rzpPaymentId, expectedPaise, payment.currency || "INR");
        if (cap.status === "captured") capturedId = t.rzpPaymentId;
        else { console.log(`  ✗ capture returned status '${cap.status}' — refusing`); continue; }
      } else {
        console.log("  (dry run — would attempt capture here; cannot confirm captured status without --apply)");
        continue;
      }
    }
    if (!capturedId) {
      console.log(`  ✗ payment status is '${payment.status}', not captured — refusing`); continue;
    }

    console.log(`  ✓ verified captured (${capturedId}) for ${row.amount}`);

    if (!APPLY) { console.log("  — dry run — re-run with --apply to flip status + confirm order."); continue; }

    await pgClient`
      UPDATE razorpay_payments
         SET status = 'paid', razorpay_payment_id = ${capturedId},
             paid_at = COALESCE(paid_at, now()), updated_at = now()
       WHERE id = ${row.id}::uuid
         AND status IN ('created', 'attempted', 'failed')
    `;
    const applied = await applyPaidPayment(row.id);
    console.log("  ✓ applied:", JSON.stringify(applied));

    const [after] = await pgClient`
      SELECT status::text AS status, payment_reference AS "paymentRef", confirmed_at, cancellation_reason AS "cancelReason"
        FROM orders WHERE id = ${row.orderId}::uuid
    `;
    console.log("  order now:", JSON.stringify(after));
  }

  await pgClient.end();
}

main().catch((err) => { console.error("\n✗ ERROR:", err); process.exit(1); });
