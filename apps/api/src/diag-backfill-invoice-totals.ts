// ═══════════════════════════════════════════════════════════════════════
// diag-backfill-invoice-totals.ts
//
// Repairs the two things generateInvoicePdfSync / generateEmployeeInvoicePdfSync
// / generateDirectSaleInvoicePdfSync now write correctly, for the rows minted
// before the fix:
//
//   1. invoices.total_amount was stored as Math.round(grand), so the header
//      did not add up (606.06 + 30.30 = 636.00). Restored from the SOURCE
//      row's grand_total — the same value the fixed code writes — NOT from
//      taxable + tax, so a row whose lines were rounded stays consistent with
//      the order it bills.
//
//   2. A counter sale's invoice kept payment_status 'unpaid' / paid_amount 0
//      forever while the PDF beside it printed PAID. Recomputed from the same
//      rule the generator uses: cash is collected in full at the counter,
//      otherwise only what the gate-pass QR actually captured counts.
//      Dealer-order and employee invoices are NOT touched here. That separate
//      decision has since been made: the dealer-order rail is handled by
//      diag-backfill-invoice-settlement.ts, which derives paid_amount from the
//      money rails via lib/invoice-settlement.ts. Run THIS script first — the
//      settlement verdict compares against invoices.total_amount, so a header
//      still holding Math.round(grand) leaves a fully paid invoice reading
//      "partial" by a few paise (933 of them before this repair).
//
// Idempotent: only rows that actually differ are written.
//
// USAGE (from apps/api):
//   npx tsx src/diag-backfill-invoice-totals.ts          # dry run
//   npx tsx src/diag-backfill-invoice-totals.ts --apply  # write
// ═══════════════════════════════════════════════════════════════════════

import { pgClient } from "./lib/db.js";

const APPLY = process.argv.includes("--apply");

async function main() {
  console.log(APPLY ? "MODE: APPLY (writing)\n" : "MODE: DRY RUN (no writes)\n");

  // ── 1. totals ──
  const totalDrift = (await pgClient`
    SELECT i.id::text AS id, i.invoice_number AS "invoiceNumber",
           i.total_amount::numeric AS stored,
           src.grand_total::numeric AS truth,
           src.rail
      FROM invoices i
      JOIN LATERAL (
        SELECT o.grand_total, 'order'::text AS rail
          FROM orders o WHERE o.id = i.order_id
        UNION ALL
        SELECT eo.grand_total, 'employee' FROM employee_orders eo WHERE eo.id = i.order_id
        UNION ALL
        SELECT ds.grand_total, 'counter'  FROM direct_sales ds  WHERE ds.id = i.order_id
        LIMIT 1
      ) src ON true
     WHERE i.total_amount <> src.grand_total
  `) as any[];

  const byRail: Record<string, { n: number; delta: number }> = {};
  for (const r of totalDrift) {
    const b = (byRail[r.rail] ??= { n: 0, delta: 0 });
    b.n += 1;
    b.delta += Number(r.truth) - Number(r.stored);
  }
  console.log(`── 1. total_amount drift: ${totalDrift.length} invoices ──`);
  for (const [rail, b] of Object.entries(byRail))
    console.log(`   ${rail.padEnd(9)} ${String(b.n).padStart(5)} rows   net correction ₹${b.delta.toFixed(2)}`);
  console.log("   sample:");
  for (const r of totalDrift.slice(0, 5))
    console.log(`     ${r.invoiceNumber}  ${r.stored} → ${r.truth}`);

  // orphans: an invoice whose source row is gone would be skipped silently
  const [{ n: orphans }] = (await pgClient`
    SELECT count(*)::int AS n FROM invoices i
     WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = i.order_id)
       AND NOT EXISTS (SELECT 1 FROM employee_orders eo WHERE eo.id = i.order_id)
       AND NOT EXISTS (SELECT 1 FROM direct_sales ds WHERE ds.id = i.order_id)
  `) as any[];
  console.log(`   invoices with no source row (left untouched): ${orphans}`);

  // ── 2. counter-sale payment status ──
  const payDrift = (await pgClient`
    SELECT i.id::text AS id, i.invoice_number AS "invoiceNumber",
           ds.gp_no AS "gpNo",
           i.payment_status AS "storedStatus", i.paid_amount::numeric AS "storedPaid",
           ds.payment_mode::text AS "paymentMode",
           ds.grand_total::numeric AS grand,
           COALESCE((
             SELECT SUM(rp.amount - rp.amount_refunded)::numeric
               FROM razorpay_payments rp
              WHERE rp.direct_sale_id = ds.id
                AND rp.kind = 'gate_pass'
                AND rp.status IN ('paid', 'refunded')
           ), 0) AS collected
      FROM invoices i
      JOIN direct_sales ds ON ds.id = i.order_id
  `) as any[];

  const payFixes = payDrift
    .map((r: any) => {
      const grand = Number(r.grand);
      const collected = Number(r.collected);
      const paid = r.paymentMode === "cash" || collected >= grand - 0.001;
      const status = paid ? "paid" : collected > 0.001 ? "partial" : "unpaid";
      const amount = paid ? grand : collected;
      return { ...r, status, amount };
    })
    .filter(
      (r: any) =>
        r.status !== r.storedStatus ||
        Math.abs(Number(r.storedPaid) - r.amount) > 0.001
    );

  console.log(`\n── 2. counter-sale payment status: ${payFixes.length} of ${payDrift.length} invoices need a change ──`);
  for (const r of payFixes.slice(0, 10))
    console.log(`     ${r.gpNo ?? r.invoiceNumber}  ${r.storedStatus}/₹${r.storedPaid} → ${r.status}/₹${r.amount.toFixed(2)}  (mode=${r.paymentMode} collected=₹${r.collected})`);

  if (!APPLY) {
    console.log("\nDry run. Re-run with --apply to write.");
    await pgClient.end();
    return;
  }

  // ── write ──
  const updated = (await pgClient`
    WITH src AS (
      SELECT i.id, s.grand_total
        FROM invoices i
        JOIN LATERAL (
          SELECT o.grand_total FROM orders o WHERE o.id = i.order_id
          UNION ALL
          SELECT eo.grand_total FROM employee_orders eo WHERE eo.id = i.order_id
          UNION ALL
          SELECT ds.grand_total FROM direct_sales ds WHERE ds.id = i.order_id
          LIMIT 1
        ) s ON true
       WHERE i.total_amount <> s.grand_total
    )
    UPDATE invoices i
       SET total_amount = src.grand_total
      FROM src WHERE src.id = i.id
    RETURNING i.id
  `) as any[];
  console.log(`\n✓ total_amount rewritten on ${updated.length} invoice(s)`);

  const [{ n: remaining }] = (await pgClient`
    SELECT count(*)::int AS n FROM invoices i
      JOIN LATERAL (
        SELECT o.grand_total FROM orders o WHERE o.id = i.order_id
        UNION ALL
        SELECT eo.grand_total FROM employee_orders eo WHERE eo.id = i.order_id
        UNION ALL
        SELECT ds.grand_total FROM direct_sales ds WHERE ds.id = i.order_id
        LIMIT 1
      ) s ON true
     WHERE i.total_amount <> s.grand_total
  `) as any[];
  console.log(`  rows still drifting after the write: ${remaining}`);

  for (const r of payFixes) {
    await pgClient`
      UPDATE invoices
         SET payment_status = ${r.status},
             paid_amount    = ${r.amount.toFixed(2)}::numeric
       WHERE id = ${r.id}::uuid
    `;
  }
  console.log(`✓ payment status backfilled on ${payFixes.length} counter-sale invoice(s)`);

  await pgClient.end();
}

main().catch(async (e) => {
  console.error(e);
  await pgClient.end();
  process.exit(1);
});
