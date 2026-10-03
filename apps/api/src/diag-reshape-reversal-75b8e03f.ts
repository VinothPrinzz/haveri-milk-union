// ═══════════════════════════════════════════════════════════════════════
// diag-reshape-reversal-75b8e03f.ts — follow-up correction.
//
// diag-reverse-double-refund-75b8e03f.ts reversed the duplicate store credit
// on order 75b8e03f, but shaped the row as a GATEWAY-REFUND reversal
// (reference_type 'refund', pointing at the razorpay_payments row, linked
// from razorpay_refunds.ledger_entry_id) — the row adminCancelOrder writes.
//
// That put it in the wrong place in the books:
//   • Day Book section 3b (order-change balance movements) deliberately
//     EXCLUDES debits on reference_type 'refund', because section 3a already
//     reports the gateway refund as the day's real cash-out. So the Day Book
//     for 2026-08-29 showed the Rs 1,323.88 "modify_refund" credit with
//     nothing against it — two refund lines totalling Rs 2,647.76 on a day
//     when only Rs 1,323.88 actually went back.
//   • razorpay_refunds.ledger_entry_id was NULL for the right reason: a
//     pay-per-order UPI collection posts a `payments` row, never a ledger
//     credit, so its refund genuinely has no ledger leg. Filling it in
//     claimed a reversal that does not correspond to any ledger credit.
//
// What the row actually reverses is the MODIFY's balance credit. Reshaping it
// to mirror that credit exactly (reference_id = the order, reference_type
// 'adjustment', voucher_type 'Adjustment', no voucher_no) puts it back where
// it belongs: Day Book section 3b picks it up as a 'modify_debit' and the two
// order-change movements net to zero, while section 3a still reports the one
// real cash refund. The dealer's available balance is untouched by the
// reshape (a debit of the same amount either way).
//
// Dealer Statements excludes order modify/cancel movements on both legs
// (finance-dealer-statements.ts section 4), so it is unaffected.
//
// USAGE (from apps/api):
//   npx tsx src/diag-reshape-reversal-75b8e03f.ts            ← dry run
//   npx tsx src/diag-reshape-reversal-75b8e03f.ts --apply    ← execute
// ═══════════════════════════════════════════════════════════════════════

import { pgClient } from "./lib/db.js";

const APPLY = process.argv.includes("--apply");

const LEDGER_ID = "bbe4f3ed-b1ca-43a0-a2fd-7650825c0dab";
const ORDER_ID  = "75b8e03f-c197-4568-ba16-b48f297f94ea";
const REFUND_ID = "d85e1ed4-5cb7-481e-a79f-95e4d8f6b49b";
const DEALER_ID = "eb53a60e-3c58-43cb-ab3a-a8cf3b3c087b";
const DATE      = "2026-08-29";

const NEW_DESC =
  `Reversal of duplicate modify refund on order ${ORDER_ID}: ` +
  `already refunded to bank via rfnd_TVbjcyXwlfTQpw`;

async function balance(): Promise<string> {
  const [r] = await pgClient`
    SELECT (COALESCE(d.opening_balance,0)
         + COALESCE((SELECT SUM(CASE WHEN dl.type='credit' THEN dl.amount
                                     WHEN dl.type='debit' THEN -dl.amount END)
                       FROM dealer_ledger dl WHERE dl.dealer_id=d.id
                        AND COALESCE(dl.voucher_type,'') <> 'Opening'),0))::text AS bal
      FROM dealers d WHERE d.id = ${DEALER_ID}::uuid`;
  return r!.bal;
}

/** The rows Day Book section 3b would list for this dealer on DATE. */
async function dayBookOrderChanges() {
  return await pgClient`
    SELECT dl.amount::text AS amount,
           CASE WHEN dl.voucher_no LIKE 'CB-%' THEN 'cheque_bounce'
                WHEN dl.voucher_no LIKE 'CC-%' THEN 'cheque_charges'
                WHEN dl.voucher_no LIKE 'CX-%' THEN 'cheque_cancel'
                WHEN dl.type = 'debit' THEN 'modify_debit'
                WHEN dl.reference_type = 'adjustment' THEN 'modify_refund'
                ELSE 'cancel_refund' END AS type,
           dl.description
      FROM dealer_ledger dl
     WHERE dl.dealer_id = ${DEALER_ID}::uuid
       AND (dl.created_at AT TIME ZONE 'Asia/Kolkata')::date = ${DATE}::date
       AND dl.amount > 0
       AND ( dl.reference_type = 'adjustment'
          OR (dl.type = 'credit' AND dl.reference_type = 'refund')
          OR (dl.type = 'credit' AND dl.reference_type = 'order'
              AND dl.voucher_type = 'Adjustment') )
       AND COALESCE(dl.voucher_type,'') <> 'Receipt'
       AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.id = dl.reference_id)
       AND NOT EXISTS (SELECT 1 FROM ledger_adjustments a WHERE a.ledger_entry_id = dl.id)
     ORDER BY dl.created_at`;
}

async function report(label: string) {
  const rows = await dayBookOrderChanges();
  let net = 0;
  console.log(`\n${label} — Day Book ${DATE}, order-change movements (section 3b):`);
  if (rows.length === 0) console.log("   (none)");
  for (const r of rows) {
    const sign = r.type === "modify_debit" ? -1 : 1;
    net += sign * parseFloat(r.amount);
    console.log(`   ${sign > 0 ? "+" : "-"} Rs ${r.amount}  ${r.type}  ${r.description}`);
  }
  console.log(`   net balance-rail movement: Rs ${net.toFixed(2)}`);
}

async function main() {
  console.log(APPLY ? "RESHAPE REVERSAL — APPLY" : "RESHAPE REVERSAL — DRY RUN");
  console.log("────────────────────────────────────────────────────────────");

  const [row] = await pgClient`
    SELECT id::text, type::text, amount::text, reference_type::text,
           reference_id::text AS "refId", voucher_type AS vt, voucher_no AS vno,
           description
      FROM dealer_ledger WHERE id = ${LEDGER_ID}::uuid`;
  if (!row) { console.log("✗ correction row not found — aborting"); await pgClient.end(); return; }
  console.log("current row:", JSON.stringify(row, null, 2));

  if (row.reference_type === "adjustment") {
    console.log("\n✓ already reshaped — nothing to do.");
    await report("CURRENT");
    await pgClient.end();
    return;
  }

  const [{ n }] = await pgClient`
    SELECT count(*)::int AS n FROM razorpay_refunds WHERE ledger_entry_id IS NULL` as any;
  console.log(`\nrazorpay_refunds rows with no ledger leg (the norm for pay-per-order UPI): ${n}`);

  await report("BEFORE");

  console.log(`\nreshape to: reference_id=${ORDER_ID}  reference_type='adjustment'`);
  console.log(`            voucher_type='Adjustment'  voucher_no=NULL`);
  console.log(`            "${NEW_DESC}"`);
  console.log(`and clear razorpay_refunds.ledger_entry_id (back to NULL)`);
  console.log(`\navailable balance stays Rs ${await balance()} (same debit, same amount)`);

  if (!APPLY) {
    console.log("\nDRY RUN — nothing written. Re-run with --apply.");
    await pgClient.end();
    return;
  }

  await pgClient.begin(async (_tx) => {
    const tx = _tx as unknown as typeof pgClient;
    await tx`
      UPDATE dealer_ledger
         SET reference_id   = ${ORDER_ID}::uuid,
             reference_type = 'adjustment'::ledger_ref_type,
             voucher_type   = 'Adjustment',
             voucher_no     = NULL,
             description    = ${NEW_DESC},
             particulars    = ${NEW_DESC}
       WHERE id = ${LEDGER_ID}::uuid`;
    await tx`
      UPDATE razorpay_refunds SET ledger_entry_id = NULL WHERE id = ${REFUND_ID}::uuid`;
  });
  console.log("\n✓ reshaped");
  await report("AFTER");
  console.log(`\navailable balance: Rs ${await balance()}`);
  await pgClient.end();
}
main().catch(async (e) => { console.error(e); await pgClient.end(); process.exit(1); });
