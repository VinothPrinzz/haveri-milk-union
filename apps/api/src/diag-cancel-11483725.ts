// ═══════════════════════════════════════════════════════════════════════
// diag-cancel-11483725.ts — one-off: cancel order 11483725 and refund the
// dealer as WALLET STORE CREDIT (not a bank refund).
//
// Order 11483725 (dealer A52 ATITHI UDAPI HOTEL, ₹592.80, 12 × PD0274
// SHUBHAM 1000ML, delivery 2026-07-23, status 'dispatched'):
//   • payment_mode = 'upi' — the dealer really paid ₹592.80 through Razorpay
//     (pay_TGnpC6ZXi1veqs, status 'paid', amount_refunded ₹0.00)
//   • ZERO dealer_ledger rows exist for this dealer — the UPI payment never
//     posted a ledger credit and the order never posted a placement debit,
//     so available balance and dealer_wallets.balance are both ₹0.00
//   • a `payments` receipt row (₹592.80, mode 'upi') records the money in
//     the Day Book — correct, it genuinely was received
//   • no invoice was minted for this order (nothing to void)
//
// Money the dealer paid is therefore real and unreturned → crediting the
// balance is NOT a phantom credit (contrast the wallet-cancel hazard, where
// payment_mode='wallet' orders get grand_total credited unconditionally even
// when placement never debited).
//
// ── Why adminCancelOrder(..., "balance") ──────────────────────────────
// For a upi order with a captured payment the "balance" method resolves to
// plan = { to: "ledger", amount: paidRemaining } (cancel-order.ts:241-244) —
// exactly the documented "online-paid order, but the admin chose store credit
// over a bank refund" case. That posts ONE dealer_ledger credit of ₹592.80,
// which is what the dealer app shows as their wallet: the app's balance is
// credit_available = GREATEST(0, ledger closing_balance) (dealers.ts:813),
// consumed by IndentCheckoutScreen as `₹… in wallet` — NOT dealer_wallets.
// So the ledger credit is the right and only lever; dealer_wallets stays ₹0.00
// deliberately (crediting both would double-count in the finance views).
// No Razorpay call is made, so the cash stays with the union as store credit.
//
// performed_by is NULL (system correction; the column is nullable).
//
// USAGE (from apps/api):
//   npx tsx src/diag-cancel-11483725.ts            ← dry run (inspect only)
//   npx tsx src/diag-cancel-11483725.ts --apply    ← execute
// ═══════════════════════════════════════════════════════════════════════

import { pgClient } from "./lib/db.js";
import { adminCancelOrder } from "./lib/cancel-order.js";

const APPLY = process.argv.includes("--apply");

const ORDER_ID = "11483725-c773-4319-a866-2deb36dcf541";
const DEALER_ID = "65f4e47a-d461-46b1-aa88-559a2a1ac55e";
const EXPECTED_TOTAL = 592.8;
const REASON = "Cancelled by admin — refunded to dealer wallet as store credit";
const PERFORMED_BY = null as unknown as string; // system correction → NULL

/** What the dealer app shows as "wallet": GREATEST(0, ledger closing balance). */
async function walletBalance(dealerId: string): Promise<number> {
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

async function productStock(): Promise<number> {
  const [p] = await pgClient`SELECT stock::numeric AS stock FROM products WHERE code = 'PD0274'`;
  return parseFloat(p!.stock);
}

async function main() {
  console.log(APPLY ? "CANCEL + WALLET STORE CREDIT — APPLY" : "CANCEL + WALLET STORE CREDIT — DRY RUN (inspect only)");
  console.log("────────────────────────────────────────────────────────");

  const [ord] = await pgClient`
    SELECT o.id::text, o.dealer_id::text AS "dealerId", o.status::text AS status,
           o.payment_mode::text AS "paymentMode", o.grand_total::numeric AS "grandTotal",
           o.delivery_date::text AS "deliveryDate", o.stock_deducted AS "stockDeducted",
           d.name AS "dealerName", d.code AS "dealerCode"
      FROM orders o JOIN dealers d ON d.id = o.dealer_id
     WHERE o.id = ${ORDER_ID}::uuid
  `;
  if (!ord) { console.log("✗ order not found — aborting"); await pgClient.end(); return; }
  console.log(`order  : ${ORDER_ID}`);
  console.log(`dealer : ${ord.dealerCode} ${ord.dealerName}`);
  console.log(`status : ${ord.status}  payment_mode: ${ord.paymentMode}  total: ₹${ord.grandTotal}`);
  console.log(`delivery: ${ord.deliveryDate}  stock_deducted: ${ord.stockDeducted}`);

  // ── Guards: the premise must still hold at apply time ──
  if (ord.status === "cancelled") { console.log("\n✓ already cancelled — nothing to do"); await pgClient.end(); return; }
  if (ord.dealerId !== DEALER_ID) { console.log("\n✗ dealer changed — refusing"); await pgClient.end(); return; }
  if (ord.paymentMode !== "upi") { console.log(`\n✗ payment_mode is '${ord.paymentMode}', expected 'upi' — refusing`); await pgClient.end(); return; }
  if (Math.abs(parseFloat(ord.grandTotal) - EXPECTED_TOTAL) > 0.001) {
    console.log(`\n✗ grand_total ₹${ord.grandTotal} ≠ expected ₹${EXPECTED_TOTAL} — refusing`); await pgClient.end(); return;
  }

  const [rp] = await pgClient`
    SELECT amount::numeric AS amount, amount_refunded::numeric AS refunded,
           status::text AS status, razorpay_payment_id AS "rzpId"
      FROM razorpay_payments
     WHERE order_id = ${ORDER_ID}::uuid AND kind = 'order_payment' AND status = 'paid'
  `;
  if (!rp) { console.log("\n✗ no captured 'paid' razorpay_payments row — the store-credit premise is wrong; refusing"); await pgClient.end(); return; }
  const paidRemaining = parseFloat(rp.amount) - parseFloat(rp.refunded);
  console.log(`\ngateway: ${rp.rzpId} ${rp.status} ₹${rp.amount} refunded=₹${rp.refunded} → unrefunded ₹${paidRemaining.toFixed(2)}`);
  if (paidRemaining <= 0.001) { console.log("✗ nothing left unrefunded — refusing"); await pgClient.end(); return; }

  const [{ n: ledCount }] = await pgClient`
    SELECT count(*)::int AS n FROM dealer_ledger WHERE dealer_id = ${DEALER_ID}::uuid
  ` as any[];
  console.log(`dealer_ledger rows for this dealer: ${ledCount} (expected 0 — payment posted no credit)`);
  if (ledCount !== 0) {
    console.log("⚠ ledger is no longer empty — re-inspect before crediting, a credit may already exist. Refusing.");
    await pgClient.end(); return;
  }

  const beforeWallet = await walletBalance(DEALER_ID);
  const beforeStock = await productStock();
  console.log(`\nwallet (app-visible) BEFORE: ₹${beforeWallet.toFixed(2)}`);
  console.log(`PD0274 products.stock BEFORE: ${beforeStock}`);

  console.log(`\nPLAN: adminCancelOrder(order, reason, NULL, "balance")`);
  console.log(`      → cancel + restore 12 units + dealer_ledger credit ₹${paidRemaining.toFixed(2)}`);
  console.log(`      → wallet ₹${beforeWallet.toFixed(2)} → ₹${(beforeWallet + paidRemaining).toFixed(2)}; NO Razorpay refund`);

  if (!APPLY) { console.log("\n— dry run — re-run with --apply to execute."); await pgClient.end(); return; }

  const summary = await adminCancelOrder(ORDER_ID, REASON, PERFORMED_BY, "balance");
  console.log("\n✓ adminCancelOrder returned:", JSON.stringify(summary));

  // ── Verify ──
  const [after] = await pgClient`
    SELECT status::text AS status, stock_deducted AS "stockDeducted",
           cancelled_at AS "cancelledAt", cancellation_reason AS "reason"
      FROM orders WHERE id = ${ORDER_ID}::uuid
  `;
  console.log("  order now:", JSON.stringify(after));

  const leds = await pgClient`
    SELECT type::text, amount::numeric AS amount, voucher_type AS "vType",
           description, balance_after::numeric AS "balAfter"
      FROM dealer_ledger WHERE dealer_id = ${DEALER_ID}::uuid ORDER BY created_at
  `;
  console.log(`  dealer_ledger rows now (${leds.length}):`);
  for (const l of leds) console.log(`    ${l.type} ₹${l.amount} voucher=${l.vType} bal_after=₹${l.balAfter} :: ${l.description}`);

  const [rpAfter] = await pgClient`
    SELECT status::text AS status, amount_refunded::numeric AS refunded
      FROM razorpay_payments WHERE order_id = ${ORDER_ID}::uuid AND kind = 'order_payment'
  `;
  console.log(`  razorpay_payments: status=${rpAfter!.status} amount_refunded=₹${rpAfter!.refunded} (expected: paid / ₹0.00 — no bank refund)`);

  const afterWallet = await walletBalance(DEALER_ID);
  const afterStock = await productStock();
  console.log(`\n  wallet (app-visible) AFTER : ₹${afterWallet.toFixed(2)}  (Δ ₹${(afterWallet - beforeWallet).toFixed(2)}, expected ₹${paidRemaining.toFixed(2)})`);
  console.log(`  PD0274 products.stock AFTER: ${afterStock}  (Δ ${afterStock - beforeStock}, expected +12 if it was deducted)`);

  const ok = after!.status === "cancelled"
    && Math.abs((afterWallet - beforeWallet) - paidRemaining) < 0.001
    && parseFloat(rpAfter!.refunded) === 0;
  console.log(ok ? "\n  ✓ verified: order cancelled, ₹592.80 credited to wallet, no bank refund." : "\n  ⚠ UNEXPECTED — investigate!");

  await pgClient.end();
}

main().catch((err) => { console.error("\n✗ ERROR:", err); process.exit(1); });
