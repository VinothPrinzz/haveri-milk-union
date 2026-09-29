// ═══════════════════════════════════════════════════════════════════════
// diag-backfill-invoice-settlement.ts
//
// Repairs invoices.paid_amount / payment_status for the rows minted before
// the mint learned to write them (lib/invoice-settlement.ts).
//
// Every one of the order-rail invoices in prod carries paid_amount 0 and
// payment_status 'unpaid', because nothing but the manual Record Payment
// screen ever wrote those columns. That is what made AR Aging and the
// dashboard receivables read 0, and what filled the Record Payment invoice
// picker with invoices the dealer settled weeks ago.
//
// The three settlement rails are exactly the ones resolveOrderSettlement()
// reads, restated set-based so 6.4k invoices cost one query instead of 6.4k
// round-trips (which the Supabase pooler resets part-way through). Because
// a restatement can drift from the original, the script VERIFIES itself: it
// re-resolves a random sample through the real resolveOrderSettlement() and
// refuses to write if any verdict disagrees.
//
// RUN diag-backfill-invoice-totals.ts FIRST. The verdict compares what was
// collected against invoices.total_amount, and the worker used to store that
// as Math.round(grand) — so 933 invoices the dealer paid in full come out
// "partial", short by under a rupee, until the header is repaired.
//
// USAGE (from apps/api):
//   npx tsx src/diag-backfill-invoice-settlement.ts           ← DRY RUN
//   npx tsx src/diag-backfill-invoice-settlement.ts --apply    ← writes
//
// The dry run reads only. It prints the full before/after distribution and
// a per-rail breakdown so the numbers can be checked against the finance
// team's own view of who owes what BEFORE anything is written.
// ═══════════════════════════════════════════════════════════════════════
import { pgClient } from "./lib/db.js";
import { resolveOrderSettlement } from "./lib/invoice-settlement.js";

const APPLY = process.argv.includes("--apply");
const SAMPLE = 60;

interface Row {
  id: string;
  invoice_number: string;
  order_id: string;
  total_amount: string;
  paid_amount: string;
  payment_status: string;
  payment_reference: string | null;
  customer_type: string | null;
  order_status: string;
  payment_mode: string;
  is_credit_inst: boolean;
  razorpay_net: string;
  ledger_net: string;
  receipts: string;
}

const inr = (n: number) =>
  "₹" + n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * The verdict, from the three rail subtotals. Kept as one function so the
 * set-based path and the per-order helper cannot round or clamp differently.
 */
function verdict(razorpayNet: number, ledgerNet: number, receipts: number, total: number) {
  const paidAmount = Math.max(0, Math.min(total, razorpayNet + ledgerNet + receipts));
  const status =
    paidAmount >= total - 0.01 && total > 0 ? "paid"
    : paidAmount > 0.01                     ? "partial"
    :                                         "unpaid";
  return { paidAmount, status };
}

async function main() {
  console.log(APPLY ? "\n*** APPLY MODE - this will write ***\n" : "\n--- DRY RUN (no writes) ---\n");

  // Only the dealer-order rail. invoices.order_id is polymorphic: it also
  // points at direct_sales (whose mint already writes settlement from the QR)
  // and employee_orders (a salary-recovery credit sale that is never "paid"
  // in this system), so both are deliberately left alone.
  const rows = (await pgClient`
    SELECT
      i.id, i.invoice_number, i.order_id,
      i.total_amount, i.paid_amount, i.payment_status,
      o.payment_reference,
      o.status::text       AS order_status,
      o.payment_mode::text AS payment_mode,
      d.customer_type,
      (d.customer_type::text LIKE 'Credit Inst%') AS is_credit_inst,

      -- Rail 1: Razorpay captured for this order, less refunds processed.
      COALESCE((
        SELECT sum(p.amount) FROM payments p
         WHERE o.payment_reference IS NOT NULL
           AND p.reference = o.payment_reference
      ), 0)
      - COALESCE((
        SELECT sum(rr.amount) FROM razorpay_refunds rr
         WHERE o.payment_reference IS NOT NULL
           AND rr.razorpay_payment_id = o.payment_reference
           AND rr.status = 'processed'
      ), 0)                                            AS razorpay_net,

      -- Rail 2: prepaid balance spent, less anything credited back. Never
      -- counted for a credit institution, whose debit books a receivable.
      -- 'adjustment' keyed to the order id is the modify-order delta; see the
      -- note on the same CASE in lib/invoice-settlement.ts. The two must stay
      -- identical or the self-check below refuses to write.
      CASE WHEN d.customer_type::text LIKE 'Credit Inst%' THEN 0 ELSE COALESCE((
        SELECT sum(CASE
                     WHEN dl.type = 'debit'  AND dl.reference_type IN ('order', 'adjustment')
                       THEN  dl.amount
                     WHEN dl.type = 'credit' AND dl.reference_type IN ('order', 'refund', 'adjustment')
                       THEN -dl.amount
                     ELSE 0
                   END)
          FROM dealer_ledger dl
         WHERE dl.reference_id = o.id
      ), 0) END                                        AS ledger_net,

      -- Rail 3: receipts recorded against this invoice by an admin.
      COALESCE((
        SELECT sum(p2.amount) FROM payments p2 WHERE p2.invoice_id = i.id
      ), 0)                                            AS receipts

    FROM invoices i
    JOIN orders o  ON o.id = i.order_id
    JOIN dealers d ON d.id = i.dealer_id
    ORDER BY i.invoice_date
  `) as unknown as Row[];

  console.log(`${rows.length} order-rail invoices evaluated.\n`);

  // ── Self-check: the set-based rails must agree with the real helper ──
  const picks: Row[] = [];
  const step = Math.max(1, Math.floor(rows.length / SAMPLE));
  for (let i = 0; i < rows.length && picks.length < SAMPLE; i += step) picks.push(rows[i]!);
  // Always include the awkward ones, not just an even spread.
  for (const r of rows) {
    if (picks.length >= SAMPLE * 2) break;
    const odd = r.is_credit_inst || r.order_status === "cancelled" || Number(r.receipts) > 0;
    if (odd && !picks.includes(r)) picks.push(r);
  }

  let mismatches = 0;
  for (const r of picks) {
    const total = parseFloat(r.total_amount ?? "0");
    const mine = verdict(
      Number(r.razorpay_net), Number(r.ledger_net), Number(r.receipts), total);
    const theirs = await resolveOrderSettlement({
      orderId: r.order_id,
      paymentReference: r.payment_reference,
      customerType: r.customer_type,
      grandTotal: total,
    });
    if (Math.abs(mine.paidAmount - theirs.paidAmount) > 0.005 ||
        mine.status !== theirs.paymentStatus) {
      mismatches += 1;
      console.error(
        `MISMATCH ${r.invoice_number}: set-based ${mine.status}/${mine.paidAmount.toFixed(2)} ` +
        `vs helper ${theirs.paymentStatus}/${theirs.paidAmount.toFixed(2)}`);
    }
  }
  console.log(
    `Self-check: ${picks.length} invoices re-resolved through resolveOrderSettlement(), ` +
    `${mismatches} mismatches.\n`);
  if (mismatches > 0) {
    console.error("Refusing to continue - the set-based query disagrees with the helper.");
    process.exitCode = 1;
    return;
  }

  // ── Distribution ────────────────────────────────────────────────────
  type Bucket = { n: number; amount: number };
  const byRail = new Map<string, { paid: Bucket; partial: Bucket; unpaid: Bucket }>();
  const changes: Array<{ r: Row; paidAmount: number; status: string }> = [];
  let unchanged = 0;

  for (const r of rows) {
    const total = parseFloat(r.total_amount ?? "0");
    const { paidAmount, status } = verdict(
      Number(r.razorpay_net), Number(r.ledger_net), Number(r.receipts), total);

    const rail =
      r.is_credit_inst             ? "credit institution (on account)"
      : r.payment_mode === "upi"    ? "pay-per-order UPI"
      : r.payment_mode === "credit" ? "dealer balance"
      :                               r.payment_mode;

    if (!byRail.has(rail)) {
      byRail.set(rail, {
        paid: { n: 0, amount: 0 }, partial: { n: 0, amount: 0 }, unpaid: { n: 0, amount: 0 },
      });
    }
    const b = byRail.get(rail)!;
    b[status as "paid" | "partial" | "unpaid"].n += 1;
    b[status as "paid" | "partial" | "unpaid"].amount += total;

    const samePaid = Math.abs(parseFloat(r.paid_amount ?? "0") - paidAmount) < 0.005;
    if (samePaid && r.payment_status === status) unchanged += 1;
    else changes.push({ r, paidAmount, status });
  }

  console.log("-- Resulting status by settlement rail ---------------------");
  console.table(
    [...byRail.entries()].map(([rail, b]) => ({
      rail,
      paid: b.paid.n,
      "paid value": inr(b.paid.amount),
      partial: b.partial.n,
      unpaid: b.unpaid.n,
      "unpaid value": inr(b.unpaid.amount),
    }))
  );

  const stillOwed = [...byRail.values()].reduce(
    (s, b) => s + b.unpaid.amount + b.partial.amount, 0);
  console.log(`\n${changes.length} invoices change, ${unchanged} already correct.`);
  console.log(`Receivable after backfill (unpaid + partial totals): ${inr(stillOwed)}`);

  // Cancelled orders must never come out "paid" - the money went back.
  const badCancelled = changes.filter(
    c => c.r.order_status === "cancelled" && c.status === "paid");
  console.log(`\nCancelled orders landing on 'paid': ${badCancelled.length}`);
  for (const c of badCancelled.slice(0, 20)) {
    console.log(
      `   ${c.r.invoice_number}  ${inr(parseFloat(c.r.total_amount))}  ` +
      `mode=${c.r.payment_mode}  order ${c.r.order_id.slice(0, 8)}`);
  }

  console.log("\n-- Sample of changes --------------------------------------");
  console.table(changes.slice(0, 12).map(c => ({
    invoice: c.r.invoice_number,
    mode: c.r.payment_mode,
    order: c.r.order_status,
    total: c.r.total_amount,
    was: `${c.r.payment_status} / ${c.r.paid_amount}`,
    becomes: `${c.status} / ${c.paidAmount.toFixed(2)}`,
  })));

  if (!APPLY) {
    console.log("\nDry run complete. Re-run with --apply to write these changes.");
    return;
  }

  // Chunked so one statement never carries thousands of parameters, and so a
  // failure part-way leaves a consistent prefix rather than a torn table.
  const CHUNK = 200;
  let written = 0;
  for (let i = 0; i < changes.length; i += CHUNK) {
    const slice = changes.slice(i, i + CHUNK);
    await pgClient.begin(async (_tx) => {
      const tx = _tx as unknown as typeof pgClient;
      for (const c of slice) {
        await tx`
          UPDATE invoices
             SET paid_amount    = ${c.paidAmount.toFixed(2)}::numeric,
                 payment_status = ${c.status}
           WHERE id = ${c.r.id}::uuid
        `;
      }
    });
    written += slice.length;
    console.log(`   ${written}/${changes.length}`);
  }
  console.log(`\nDone. ${written} invoices updated.`);
}

await main();
await pgClient.end();
