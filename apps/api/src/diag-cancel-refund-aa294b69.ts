// ═══════════════════════════════════════════════════════════════════════
// diag-cancel-refund-aa294b69.ts — one-off: cancel the order behind invoice
// INV-HMU-2026-AA294B69 and refund it to the dealer's WALLET / available
// balance via the live admin path: adminCancelOrder(..., "balance").
// Same approach as diag-cancel-refund-wallet.ts, but resolves the order
// from the invoice number and does not assume the payment mode.
//
// USAGE (from apps/api):
//   npx tsx src/diag-cancel-refund-aa294b69.ts            ← dry run (inspect only)
//   npx tsx src/diag-cancel-refund-aa294b69.ts --apply    ← execute
// ═══════════════════════════════════════════════════════════════════════

import { pgClient } from "./lib/db.js";
import { adminCancelOrder, RefundError } from "./lib/cancel-order.js";
import { walletDebitedForOrder, balanceRefundedForOrder } from "./lib/refund-accounting.js";

const APPLY = process.argv.includes("--apply");

const INVOICE_NUMBER = "INV-HMU-2026-AA294B69";
const REASON = "Admin cancellation — refunded to dealer wallet (store credit)";
const PERFORMED_BY = null as unknown as string; // system correction → NULL

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

async function walletBalance(dealerId: string): Promise<string> {
  const [w] = await pgClient`SELECT balance::numeric AS b FROM dealer_wallets WHERE dealer_id = ${dealerId}::uuid`;
  return w ? String(w.b) : "(no wallet row)";
}

async function main() {
  console.log(APPLY ? "CANCEL + REFUND TO WALLET — APPLY" : "CANCEL + REFUND TO WALLET — DRY RUN (inspect only)");

  const invs = await pgClient`
    SELECT id::text, order_id::text AS "orderId", dealer_id::text AS "dealerId",
           invoice_number AS "invoiceNumber"
      FROM invoices WHERE invoice_number = ${INVOICE_NUMBER}
  `;
  console.log(`invoices matching ${INVOICE_NUMBER}: ${invs.length}`);
  for (const i of invs) console.log("  ", JSON.stringify(i));
  if (invs.length !== 1) { console.log("  ✗ expected exactly one invoice — aborting"); await pgClient.end(); return; }
  const orderId = invs[0]!.orderId;

  const [ord] = await pgClient`
    SELECT o.id::text, o.dealer_id::text AS "dealerId", d.name AS "dealerName",
           o.status::text AS status, o.payment_mode::text AS "paymentMode",
           o.grand_total::numeric AS "grandTotal", o.delivery_date::text AS "deliveryDate"
      FROM orders o LEFT JOIN dealers d ON d.id = o.dealer_id
     WHERE o.id = ${orderId}::uuid
  `;
  if (!ord) { console.log(`  ✗ ${orderId} is not a dealer order (employee order / direct sale?) — aborting`); await pgClient.end(); return; }
  console.log("order:", JSON.stringify(ord));

  if (ord.status === "cancelled") { console.log("  ✓ already cancelled — nothing to do"); await pgClient.end(); return; }
  if (!["confirmed", "dispatched", "payment_required"].includes(ord.status)) {
    console.log(`  ✗ order is '${ord.status}' — not a cancellable state; aborting`); await pgClient.end(); return;
  }

  const rps = await pgClient`
    SELECT razorpay_payment_id AS "rzpPaymentId", status::text AS status,
           amount::numeric AS amount, amount_refunded::numeric AS "amountRefunded"
      FROM razorpay_payments WHERE order_id = ${orderId}::uuid AND kind = 'order_payment'
  `;
  console.log(`razorpay order payments: ${rps.length}`);
  for (const r of rps) console.log("  ", JSON.stringify(r));

  const ledger = await pgClient`
    SELECT type::text, amount::numeric AS amount, reference_type::text AS "refType",
           voucher_type AS "voucherType", description, created_at AS "createdAt"
      FROM dealer_ledger WHERE reference_id = ${orderId}::uuid ORDER BY created_at
  `;
  console.log(`ledger rows referencing order: ${ledger.length}`);
  for (const l of ledger) console.log("  ", JSON.stringify(l));

  console.log(`wallet debited for order: ₹${(await walletDebitedForOrder(pgClient, orderId)).toFixed(2)}`);
  console.log(`already refunded to balance: ₹${(await balanceRefundedForOrder(pgClient, orderId)).toFixed(2)}`);
  const beforeAvail = await availableBalance(ord.dealerId);
  const beforeWallet = await walletBalance(ord.dealerId);
  console.log(`dealer available balance BEFORE: ₹${beforeAvail.toFixed(2)} | dealer_wallets.balance BEFORE: ${beforeWallet}`);

  if (!APPLY) { console.log("\n— dry run — re-run with --apply to execute."); await pgClient.end(); return; }

  let summary;
  try {
    summary = await adminCancelOrder(orderId, REASON, PERFORMED_BY, "balance");
  } catch (err) {
    if (err instanceof RefundError) { console.log("  ✗ RefundError:", err.message); await pgClient.end(); process.exit(1); }
    throw err;
  }
  console.log("✓ cancelled:", JSON.stringify(summary));

  const [after] = await pgClient`
    SELECT status::text AS status, cancelled_at AS "cancelledAt", cancellation_reason AS "cancelReason"
      FROM orders WHERE id = ${orderId}::uuid
  `;
  console.log("order now:", JSON.stringify(after));
  const afterAvail = await availableBalance(ord.dealerId);
  console.log(`dealer available balance AFTER: ₹${afterAvail.toFixed(2)} (Δ ₹${(afterAvail - beforeAvail).toFixed(2)}) | dealer_wallets.balance AFTER: ${await walletBalance(ord.dealerId)}`);

  await pgClient.end();
}

main().catch((err) => { console.error("\n✗ ERROR:", err); process.exit(1); });
