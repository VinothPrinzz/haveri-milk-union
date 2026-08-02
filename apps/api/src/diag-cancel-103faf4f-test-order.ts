// ═══════════════════════════════════════════════════════════════════════
// diag-cancel-103faf4f-test-order.ts — one-off: cancel ONE test order that
// was NEVER paid, moving NO money.
//
// Order 103faf4f (dealer L13 LAXMI NAYKAR, ₹892.50, delivery 2026-07-01,
// status 'confirmed') has payment_mode='wallet' but was never charged:
//   • no razorpay_payments row of any kind links to it
//   • no dealer_ledger row references it (no placement debit)
//   • no receipt in `payments`
//   • dealer's ledger balance at placement was ₹0.00 — it could not have
//     satisfied the wallet gate (balance >= grand_total, orders.ts:538)
//   • stock_deducted = false
// Nothing was paid, so nothing was refunded and nothing is owed back.
//
// ── Why NOT adminCancelOrder ──────────────────────────────────────────
// Every refundMethod is wrong for this order:
//   • "razorpay" → RefundError (no captured payment to refund)
//   • "balance"  → payment_mode==='wallet' hits the UNCONDITIONAL branch
//                  plan = { to:"wallet", amount: grandTotal } (cancel-order.ts:237),
//                  which assumes placement debited the wallet. It didn't.
//                  That would CREDIT ₹892.50 the dealer never paid —
//                  wallet ₹0.00 → ₹892.50 and ledger closing ₹183.53 → ₹1076.03.
//   • omitted    → auto-rule: not 'upi' → falls through to "balance" → same.
// (The sibling diag diag-cancel-066cc05d-refunded.ts could use "balance"
// safely only because that order was payment_mode='upi', where the plan
// collapses to { to:"none" } when nothing is refundable.)
//
// So we call the lower-level primitive the admin path itself uses —
// cancelOrderWithReversal(tx, ..., { to: "none" }) — which does exactly:
//   UPDATE orders → cancelled + restoreOrderStock, and no money movement.
// restoreOrderStock is a no-op here (guarded on stock_deducted = true,
// stock-check.ts:324), so the vestigial products.stock counter is untouched.
//
// performed_by is NULL (system correction) and is unused on the "none" plan.
//
// USAGE (from apps/api):
//   npx tsx src/diag-cancel-103faf4f-test-order.ts            ← dry run (inspect only)
//   npx tsx src/diag-cancel-103faf4f-test-order.ts --apply    ← execute
// ═══════════════════════════════════════════════════════════════════════

import { pgClient } from "./lib/db.js";
import { cancelOrderWithReversal } from "./lib/cancel-order.js";

const APPLY = process.argv.includes("--apply");

const ORDER_ID = "103faf4f-d42c-4107-aca0-85467445ca81";
const REASON = "Cancelled — test order, never paid (no refund due)";
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
  console.log(APPLY ? "CANCEL TEST ORDER (no money) — APPLY" : "CANCEL TEST ORDER (no money) — DRY RUN (inspect only)");
  console.log("\n────────────────────────────────────────────────────────");
  console.log(`order ${ORDER_ID}`);

  const [ord] = await pgClient`
    SELECT id::text, dealer_id::text AS "dealerId", status::text AS status,
           payment_mode::text AS "paymentMode", grand_total::numeric AS "grandTotal",
           delivery_date::text AS "deliveryDate", stock_deducted AS "stockDeducted"
      FROM orders WHERE id = ${ORDER_ID}::uuid
  `;
  if (!ord) { console.log("  ✗ order not found — aborting"); await pgClient.end(); return; }
  console.log(`  status=${ord.status} payment_mode=${ord.paymentMode} grand_total=₹${ord.grandTotal} delivery=${ord.deliveryDate} stock_deducted=${ord.stockDeducted}`);

  if (ord.status === "cancelled") { console.log("  ✓ already cancelled — nothing to do"); await pgClient.end(); return; }
  if (!["confirmed", "dispatched", "payment_required", "pending"].includes(ord.status)) {
    console.log(`  ✗ order is '${ord.status}' — not a cancellable state; aborting`); await pgClient.end(); return;
  }

  // ── Guards: prove NOTHING was ever paid. If any fail, the "no refund"
  //    premise is wrong and money would be stranded — refuse and re-inspect.
  const [{ n: rpCount }] = await pgClient`
    SELECT count(*)::int AS n FROM razorpay_payments
     WHERE order_id = ${ORDER_ID}::uuid AND status IN ('paid','refunded')
  ` as any[];
  if (rpCount > 0) {
    console.log(`  ✗ ${rpCount} paid/refunded razorpay_payments row(s) exist — this order WAS paid; refusing.`);
    await pgClient.end(); return;
  }

  const [{ n: debitCount }] = await pgClient`
    SELECT count(*)::int AS n FROM dealer_ledger
     WHERE reference_id = ${ORDER_ID}::uuid AND type = 'debit'
  ` as any[];
  if (debitCount > 0) {
    console.log(`  ✗ ${debitCount} ledger debit(s) reference this order — the dealer WAS charged; refusing.`);
    await pgClient.end(); return;
  }

  console.log("  ✓ guards pass: no paid/refunded gateway row, no ledger debit → nothing was ever charged");

  const before = await availableBalance(ord.dealerId);
  console.log(`  dealer available balance BEFORE: ₹${before.toFixed(2)}`);

  console.log(`\n  PLAN: cancel order only. plan={to:"none"} → NO wallet credit, NO ledger row, NO Razorpay call.`);
  console.log(`        restoreOrderStock is a no-op (stock_deducted=${ord.stockDeducted}).`);

  if (!APPLY) {
    console.log("\n  — dry run — re-run with --apply to execute.");
    await pgClient.end(); return;
  }

  await pgClient.begin(async (_tx) => {
    const tx = _tx as unknown as typeof pgClient;
    await cancelOrderWithReversal(tx, ORDER_ID, REASON, PERFORMED_BY, { to: "none" });
  });

  const [after] = await pgClient`
    SELECT status::text AS status, stock_deducted AS "stockDeducted",
           cancelled_at AS "cancelledAt", cancellation_reason AS "cancelReason"
      FROM orders WHERE id = ${ORDER_ID}::uuid
  `;
  console.log("\n  ✓ order now:", JSON.stringify(after));

  const [{ n: ledAfter }] = await pgClient`
    SELECT count(*)::int AS n FROM dealer_ledger WHERE reference_id = ${ORDER_ID}::uuid
  ` as any[];
  const afterBal = await availableBalance(ord.dealerId);
  console.log(`  dealer_ledger rows for this order: ${ledAfter} (expected 0)`);
  console.log(`  dealer available balance AFTER : ₹${afterBal.toFixed(2)}  (Δ ₹${(afterBal - before).toFixed(2)} — expected ₹0.00)`);
  if (ledAfter !== 0 || Math.abs(afterBal - before) > 0.001) {
    console.log("  ⚠ UNEXPECTED: money moved — investigate!");
  } else {
    console.log("  ✓ confirmed: no money moved.");
  }

  await pgClient.end();
}

main().catch((err) => { console.error("\n✗ ERROR:", err); process.exit(1); });
