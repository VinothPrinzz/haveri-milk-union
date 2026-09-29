// ═══════════════════════════════════════════════════════════════════════
// diag-drop-reversed-pair-75b8e03f.ts — final correction for order 75b8e03f.
//
// The order carried a matched pair of dealer_ledger rows that cancel out:
//   • the Rs 1,323.88 available-balance credit written when the indent was
//     modified to zero (the duplicate leg of the double refund), and
//   • the Rs 1,323.88 debit posted to take it back, once it was settled that
//     the bank refund (rfnd_TVbjcyXwlfTQpw, processed, unreversible) would be
//     the one that stands.
//
// Netting to zero was not enough for the books: the Day Book summary reports
// "refunds to balance" and "extra debits: modify" as SEPARATE figures and
// only nets them on a third line, so the day still read Rs 1,323.88 of
// balance refunds that never really happened. Neither row represents real
// economic activity in the final state — the day's actual movements are the
// Rs 1,323.88 receipt in and the Rs 1,323.88 gateway refund out — so both
// come out. Deleting rather than reversing again is a deliberate call by the
// operator; the incident stays documented in
// diag-reverse-double-refund-75b8e03f.ts and diag-reshape-reversal-75b8e03f.ts.
//
// The dealer's available balance is unaffected: +1,323.88 - 1,323.88 = 0.
//
// USAGE (from apps/api):
//   npx tsx src/diag-drop-reversed-pair-75b8e03f.ts            ← dry run
//   npx tsx src/diag-drop-reversed-pair-75b8e03f.ts --apply    ← execute
// ═══════════════════════════════════════════════════════════════════════

import { pgClient } from "./lib/db.js";

const APPLY  = process.argv.includes("--apply");
const ORDER  = "75b8e03f-c197-4568-ba16-b48f297f94ea";
const DEALER = "eb53a60e-3c58-43cb-ab3a-a8cf3b3c087b";
const DATE   = "2026-08-29";

async function balance(): Promise<string> {
  const [r] = await pgClient`
    SELECT (COALESCE(d.opening_balance,0)
         + COALESCE((SELECT SUM(CASE WHEN dl.type='credit' THEN dl.amount
                                     WHEN dl.type='debit' THEN -dl.amount END)
                       FROM dealer_ledger dl WHERE dl.dealer_id=d.id
                        AND COALESCE(dl.voucher_type,'') <> 'Opening'),0))::text AS bal
      FROM dealers d WHERE d.id = ${DEALER}::uuid`;
  return r!.bal;
}

async function main() {
  console.log(APPLY ? "DROP REVERSED PAIR — APPLY" : "DROP REVERSED PAIR — DRY RUN");
  console.log("────────────────────────────────────────────────────────────");

  const rows = await pgClient`
    SELECT id::text, type::text, amount::text, reference_type::text,
           voucher_type AS vt, voucher_no AS vno, description,
           created_at::text AS "createdAt"
      FROM dealer_ledger
     WHERE dealer_id = ${DEALER}::uuid AND reference_id = ${ORDER}::uuid
     ORDER BY created_at`;

  console.log(`rows on this order: ${rows.length}`);
  for (const r of rows)
    console.log(`  ${r.type === "credit" ? "+" : "-"} Rs ${r.amount}  ${r.reference_type}/${r.vt}  ${r.description}  [${r.id}]`);

  // Only proceed on an exactly-cancelling pair.
  const credits = rows.filter((r: any) => r.type === "credit");
  const debits  = rows.filter((r: any) => r.type === "debit");
  const sum = (a: any[]) => a.reduce((s, r) => s + parseFloat(r.amount), 0);
  if (rows.length !== 2 || credits.length !== 1 || debits.length !== 1 ||
      Math.abs(sum(credits) - sum(debits)) > 0.001) {
    console.log("\n✗ not an exactly-cancelling pair — aborting, nothing touched.");
    await pgClient.end();
    return;
  }

  // Nothing may still point at either row.
  const ids = rows.map((r: any) => r.id);
  const [refs] = await pgClient`
    SELECT (SELECT count(*) FROM razorpay_refunds  WHERE ledger_entry_id = ANY(${ids}::uuid[]))::int AS "rzpRefs",
           (SELECT count(*) FROM ledger_adjustments WHERE ledger_entry_id = ANY(${ids}::uuid[]))::int AS "adjRefs"`;
  console.log(`\nreferences to these rows: razorpay_refunds=${refs!.rzpRefs} ledger_adjustments=${refs!.adjRefs}`);
  if (refs!.rzpRefs > 0 || refs!.adjRefs > 0) {
    console.log("✗ still referenced — aborting.");
    await pgClient.end();
    return;
  }

  console.log(`\navailable balance before: Rs ${await balance()}  (unchanged by this: +X then -X)`);

  if (!APPLY) {
    console.log("\nDRY RUN — nothing deleted. Re-run with --apply.");
    await pgClient.end();
    return;
  }

  const del = await pgClient`
    DELETE FROM dealer_ledger WHERE id = ANY(${ids}::uuid[]) RETURNING id::text`;
  console.log(`\n✓ deleted ${del.length} ledger rows`);

  const left = await pgClient`
    SELECT count(*)::int AS n FROM dealer_ledger
     WHERE dealer_id = ${DEALER}::uuid
       AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = ${DATE}::date
       AND ( reference_type = 'adjustment'
          OR (type = 'credit' AND reference_type = 'refund')
          OR (type = 'credit' AND reference_type = 'order' AND voucher_type = 'Adjustment') )`;
  console.log(`Day Book ${DATE} order-change movements for this dealer: ${(left[0] as any).n}`);
  console.log(`available balance after: Rs ${await balance()}`);
  await pgClient.end();
}
main().catch(async (e) => { console.error(e); await pgClient.end(); process.exit(1); });
