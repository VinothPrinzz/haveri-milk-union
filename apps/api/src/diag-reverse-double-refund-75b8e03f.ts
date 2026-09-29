// ═══════════════════════════════════════════════════════════════════════
// diag-reverse-double-refund-75b8e03f.ts — one-off correction.
//
// Order 75b8e03f-c197-4568-ba16-b48f297f94ea (dealer SHASHIKALA KUNCHUR,
// S184, invoice INV-HMU-2026-75B8E03F / 8a9162a6-…) was refunded TWICE
// against a single Rs 1,323.88 UPI payment (pay_TVb6ydtQ1iDINe):
//
//   13:26 IST  modify indent to zero, refund to "available balance"
//              → dealer_ledger credit Rs 1,323.88
//                ("Modify credit refund 75b8e03f-…"), grand_total → 0.00
//   13:49 IST  cancel in All Indents, refund to "bank account"
//              → Razorpay refund rfnd_TVbjcyXwlfTQpw, Rs 1,323.88, processed
//
// The cancel read only razorpay_payments.amount_refunded (still 0, because
// the modify's refund had gone to the balance, not the gateway) and so
// refunded the whole payment a second time. adminCancelOrder now caps the
// refund at the order's current grand_total, which closes that hole.
//
// ── The correction ──────────────────────────────────────────────────────
// The bank refund is processed at Razorpay and cannot be pulled back, so it
// stands. The store credit is the leg to reverse. The reversing row is
// exactly the one adminCancelOrder MEANT to write for the bank refund and
// skipped: its `origCredit` guard looks for a dealer_ledger credit carrying
// the razorpay_payment_id, and a pay-per-order UPI collection writes a
// `payments` row instead, so no reversal was posted and razorpay_refunds
// .ledger_entry_id was left NULL.
//
// So: post that missing debit (reference_type 'refund', voucher 'Refund')
// and link it back to the razorpay_refunds row. Net effect on the dealer's
// available balance: Rs 1,323.88 → Rs 0.00, which is correct — they were
// paid back in full through the bank.
//
// A debit on reference_type 'refund' is deliberately EXCLUDED from the Day
// Book's order-changes section (finance-day-book.ts section 3b) and carries
// no ledger_adjustments row, so it cannot double-count against section 3a,
// which already reports the gateway refund as the day's real cash-out.
//
// USAGE (from apps/api):
//   npx tsx src/diag-reverse-double-refund-75b8e03f.ts            ← dry run
//   npx tsx src/diag-reverse-double-refund-75b8e03f.ts --apply    ← execute
// ═══════════════════════════════════════════════════════════════════════

import { pgClient } from "./lib/db.js";

const APPLY = process.argv.includes("--apply");

const ORDER_ID = "75b8e03f-c197-4568-ba16-b48f297f94ea";
const REFUND_ID = "d85e1ed4-5cb7-481e-a79f-95e4d8f6b49b"; // razorpay_refunds.id

/** Dealer's available balance = opening + credits − debits (excl. Opening). */
async function balance(dealerId: string): Promise<number> {
  const [row] = await pgClient`
    SELECT COALESCE(d.opening_balance, 0)
         + COALESCE((SELECT SUM(CASE WHEN dl.type = 'credit' THEN dl.amount
                                     WHEN dl.type = 'debit'  THEN -dl.amount END)
                       FROM dealer_ledger dl
                      WHERE dl.dealer_id = d.id
                        AND COALESCE(dl.voucher_type, '') <> 'Opening'), 0)
           AS bal
      FROM dealers d WHERE d.id = ${dealerId}::uuid
  `;
  return parseFloat(row!.bal);
}

async function main() {
  console.log(APPLY ? "REVERSE DOUBLE REFUND — APPLY" : "REVERSE DOUBLE REFUND — DRY RUN");
  console.log("────────────────────────────────────────────────────────────");

  const [rf] = await pgClient`
    SELECT rf.id::text, rf.dealer_id::text AS "dealerId",
           rf.razorpay_payment_row::text AS "rpRowId",
           rf.razorpay_refund_id AS "refundId",
           rf.razorpay_payment_id AS "paymentId",
           rf.amount::text AS amount, rf.status::text AS status,
           rf.reason, rf.ledger_entry_id::text AS "ledgerEntryId",
           rf.created_at::text AS "createdAt",
           d.name AS "dealerName", d.code AS "dealerCode"
      FROM razorpay_refunds rf
      JOIN dealers d ON d.id = rf.dealer_id
     WHERE rf.id = ${REFUND_ID}::uuid
  `;
  if (!rf) { console.log("✗ razorpay_refunds row not found — aborting"); await pgClient.end(); return; }

  console.log(`dealer   : ${rf.dealerName} (${rf.dealerCode})`);
  console.log(`bank ref.: ${rf.refundId} for ${rf.paymentId}`);
  console.log(`           Rs ${rf.amount}, status=${rf.status}, at ${rf.createdAt}`);
  console.log(`           ledger_entry_id = ${rf.ledgerEntryId ?? "NULL (the missing reversal)"}`);

  if (rf.ledgerEntryId) {
    console.log("\n✓ This refund already carries a ledger reversal — nothing to do.");
    await pgClient.end();
    return;
  }
  if (rf.status !== "processed") {
    console.log(`\n✗ Refund status is '${rf.status}', not 'processed' — aborting.`);
    await pgClient.end();
    return;
  }

  // The store credit this correction offsets.
  const credits = await pgClient`
    SELECT id::text, type::text, amount::text, description, created_at::text AS "at"
      FROM dealer_ledger
     WHERE dealer_id = ${rf.dealerId}::uuid
       AND reference_id = ${ORDER_ID}::uuid
       AND type = 'credit'
     ORDER BY created_at
  `;
  console.log("\nstore-credit rows on this order:");
  for (const c of credits) console.log(`  + Rs ${c.amount}  ${c.description}  (${c.at})`);
  if (credits.length === 0) {
    console.log("  (none) — the balance leg is already gone; aborting so nothing is over-reversed.");
    await pgClient.end();
    return;
  }

  const amount = parseFloat(rf.amount);
  const before = await balance(rf.dealerId);
  const after = before - amount;
  console.log(`\navailable balance: Rs ${before.toFixed(2)} → Rs ${after.toFixed(2)}  (debit Rs ${amount.toFixed(2)})`);

  const voucherNo = "RF-" + String(rf.refundId).slice(-8).toUpperCase();
  const desc = `Razorpay refund ${rf.refundId} for ${rf.paymentId}, cancel: ${rf.reason}`;
  console.log(`\nrow to insert: debit Rs ${amount.toFixed(2)}  voucher ${voucherNo}  ref_type 'refund'`);
  console.log(`               "${desc}"`);

  if (!APPLY) {
    console.log("\nDRY RUN — nothing written. Re-run with --apply to post it.");
    await pgClient.end();
    return;
  }

  await pgClient.begin(async (_tx) => {
    const tx = _tx as unknown as typeof pgClient;
    const [led] = await tx`
      INSERT INTO dealer_ledger (
        dealer_id, type, amount,
        reference_id, reference_type,
        description, balance_after, performed_by,
        voucher_no, voucher_type, particulars, voucher_date
      ) VALUES (
        ${rf.dealerId}::uuid, 'debit', ${amount.toFixed(2)}::numeric,
        ${rf.rpRowId}::uuid, 'refund'::ledger_ref_type,
        ${desc}, ${after.toFixed(2)}::numeric, NULL,
        ${voucherNo}, 'Refund', ${desc},
        (${rf.createdAt}::timestamptz AT TIME ZONE 'Asia/Kolkata')::date
      )
      RETURNING id::text
    `;
    await tx`
      UPDATE razorpay_refunds SET ledger_entry_id = ${led!.id}::uuid
       WHERE id = ${REFUND_ID}::uuid
    `;
    console.log(`\n✓ posted dealer_ledger ${led!.id} and linked it to the refund`);
  });

  console.log(`✓ available balance now Rs ${(await balance(rf.dealerId)).toFixed(2)}`);
  await pgClient.end();
}

main().catch(async (e) => { console.error(e); await pgClient.end(); process.exit(1); });
