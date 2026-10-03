// ═══════════════════════════════════════════════════════════════════════
// diag-fix-gp0051-cash-to-credit.ts
//
// GP-0051 (direct_sales 41c8a420-4f87-44a6-8f91-6ea291c622fd) is an AGENT
// gate pass for H37 HAIDARALI KUNDUR, Rs.28,985.40 on 2026-08-14, rung up
// on `cash` by mistake. Nobody paid at the counter; it is a credit pass.
//
// ── Why this is a four-part change, not a column flip ──
// Unlike the employee-subsidy rail (where cash posts nothing), a CASH gate
// pass posts real money and its invoice reads PAID. Since 2026-08-13 the
// direct-sale rail settles like this (lib/direct-sale-money.ts):
//
//   cash   — a `payments` receipt, so the Day Book's cash position sees it,
//            and lib/invoice-pdf.ts stamps the invoice PAID in full.
//   credit — a dealer_ledger debit that does NOT count as payment, so the
//            invoice stays a receivable and ages in AR Aging.
//
// GP-0051 currently carries the cash side of that: one `payments` row for
// the full Rs.28,985.40 and an invoice reading paid / Rs.28,985.40. So the
// books say the union collected nearly Rs.29k of counter cash that never
// arrived, and that the agent owes nothing. Four writes move it across:
//
//   1. direct_sales.payment_mode  -> 'credit'
//   2. remove the counter cash receipt  (reverseCounterCashReceipt)
//   3. post the dealer_ledger debit     (debitDealerBalance)
//   4. reissue the invoice so paid_amount / payment_status re-derive from
//      the new mode, and the PDF stops printing PAID
//
// Step 2 DELETES rather than reverses, because `payments` has a
// CHECK (amount > 0) and no reversal concept — the same thing the PATCH
// /items path does when an edit changes what a cash pass took.
//
// Step 4 goes through reissueDirectSaleInvoiceIfExists so the row and the
// PDF are re-derived by the SAME code that mints them, rather than by a
// hand-written UPDATE that could drift from it. invoice_number, invoice_date
// and due_date are preserved by the mint's ON CONFLICT clause; the
// direct-sale rail deliberately dates a counter invoice due on the day it
// is issued, for cash and credit alike, so the due date does not move.
//
// The library helpers are used rather than open-coded SQL so the postings
// are byte-for-byte what the app itself writes.
//
// Idempotent: an existing ledger posting against this sale means the fix has
// run, and the script stops rather than billing the agent twice.
//
// USAGE (from apps/api):
//   npx tsx src/diag-fix-gp0051-cash-to-credit.ts           # dry run
//   npx tsx src/diag-fix-gp0051-cash-to-credit.ts --apply
// ═══════════════════════════════════════════════════════════════════════
import { pgClient } from "./lib/db.js";
import {
  debitDealerBalance,
  reverseCounterCashReceipt,
  ledgerPostedForSale,
  loadDirectSaleMoney,
} from "./lib/direct-sale-money.js";
import { reissueDirectSaleInvoiceIfExists } from "./lib/invoice-pdf.js";

const APPLY = process.argv.includes("--apply");
const GP = "GP-0051";

const [sale] = (await pgClient`
  SELECT ds.id::text AS id, ds.gp_no AS "gpNo",
         ds.sale_date::text AS "saleDate",
         ds.status::text AS status,
         ds.customer_type::text AS "customerType",
         ds.customer_id::text AS "customerId",
         ds.payment_mode::text AS mode,
         ds.payment_ref AS "paymentRef",
         ds.grand_total::float8 AS total,
         ds.officer_id::text AS "officerId",
         d.code AS "dealerCode", d.name AS "dealerName",
         d.customer_type::text AS "dealerCustType"
    FROM direct_sales ds
    LEFT JOIN dealers d ON d.id = ds.customer_id
   WHERE ds.gp_no = ${GP}
   LIMIT 1
`) as any[];

if (!sale) {
  console.error(`No direct_sales row with gp_no = ${GP}`);
  await pgClient.end();
  process.exit(1);
}

console.log("== Target ==");
console.table([{
  gpNo: sale.gpNo, id: sale.id, date: sale.saleDate, status: sale.status,
  dealer: `${sale.dealerCode} ${sale.dealerName}`.trim(),
  custType: sale.dealerCustType, mode: sale.mode, total: sale.total,
}]);

// ── Guards. Each is a reason NOT to write. ──
const problems: string[] = [];

if (sale.mode !== "cash") {
  problems.push(`payment_mode is already '${sale.mode}', not 'cash'. Nothing to change.`);
}
if (sale.status === "cancelled") {
  problems.push(`This sale is cancelled; billing the agent would invent debt.`);
}
if (sale.customerType !== "agent") {
  problems.push(
    `customer_type is '${sale.customerType}', not 'agent'. Only an agent pass has a ` +
    `dealer ledger to bill; a counter customer has none.`,
  );
}

// Gateway money would mean somebody really did pay, whatever the mode says.
const money = await loadDirectSaleMoney(pgClient, sale.id);
if (money.collected > 0.001) {
  problems.push(
    `The counter QR collected Rs.${money.collected.toFixed(2)} against this pass. ` +
    `That is real money in the bank and must be refunded, not reclassified.`,
  );
}

const posted = await ledgerPostedForSale(pgClient, sale.id);
if (posted > 0.001) {
  problems.push(
    `Rs.${posted.toFixed(2)} is already posted to the dealer ledger for this sale. ` +
    `The fix has already run.`,
  );
}

if (problems.length > 0) {
  console.log("\nABORT:");
  for (const p of problems) console.log(`  * ${p}`);
  await pgClient.end();
  process.exit(1);
}

// ── What the cash side holds today ──
const receipts = (await pgClient`
  SELECT p.id::text AS id, p.received_date::text AS "receivedDate",
         p.amount::float8 AS amount, p.mode::text AS mode, p.reference, p.notes
    FROM payments p
   WHERE p.mode = 'cash'
     AND p.notes IN (
       ${"Counter cash for gate pass " + GP},
       ${"Counter cash for gate pass " + sale.id}
     )
`) as any[];
const receiptTotal = receipts.reduce((s, r) => s + Number(r.amount), 0);
console.log("\n== Counter cash receipt(s) to remove ==");
console.table(receipts);
if (Math.abs(receiptTotal - sale.total) > 0.01) {
  console.log(
    `  NOTE receipts total Rs.${receiptTotal.toFixed(2)} but the pass is ` +
    `Rs.${sale.total.toFixed(2)}. Only the receipt is removed; the ledger debit ` +
    `is always the full pass total, which is what the agent owes.`,
  );
}

const [inv] = (await pgClient`
  SELECT invoice_number AS "invoiceNumber", total_amount::float8 AS total,
         paid_amount::float8 AS paid, payment_status::text AS "paymentStatus",
         due_date::text AS "dueDate"
    FROM invoices WHERE order_id = ${sale.id}::uuid
`) as any[];
console.log("\n== Invoice today ==");
console.table(inv ? [inv] : []);

// A FUNCTION, not a shared query object. postgres.js queries are lazy but
// execute ONCE: awaiting the same object a second time hands back the first
// result from cache instead of re-running it. Holding one object and awaiting
// it either side of the writes therefore reports the PRE-write balance twice,
// which reads as "the ledger debit changed nothing" - the exact opposite of
// what happened. Re-querying is the only way to see the balance move.
async function dealerBalance(): Promise<number> {
  const [row] = (await pgClient`
    SELECT
      COALESCE(d.opening_balance, 0)
      + COALESCE((SELECT SUM(CASE WHEN dl.type='credit'
            AND COALESCE(dl.voucher_type,'') <> 'Opening'
            THEN dl.amount ELSE 0 END)
          FROM dealer_ledger dl WHERE dl.dealer_id = d.id), 0)
      - COALESCE((SELECT SUM(CASE WHEN dl.type='debit'
            AND COALESCE(dl.voucher_type,'') <> 'Opening'
            THEN dl.amount ELSE 0 END)
          FROM dealer_ledger dl WHERE dl.dealer_id = d.id), 0)
      AS bal
    FROM dealers d WHERE d.id = ${sale.customerId}::uuid
  `) as any[];
  if (!row) throw new Error(`Dealer ${sale.customerId} not found`);
  return parseFloat(row.bal);
}
const balBefore = await dealerBalance();

console.log("\n== Planned writes ==");
console.log(`  1. direct_sales.payment_mode   : 'cash' -> 'credit'`);
console.log(`  2. remove counter cash receipt : Rs.${receiptTotal.toFixed(2)}`);
console.log(`  3. dealer_ledger debit         : Rs.${sale.total.toFixed(2)}`);
console.log(
  `  4. reissue invoice ${inv?.invoiceNumber ?? "(none)"} : paid ` +
  `Rs.${Number(inv?.paid ?? 0).toFixed(2)} -> Rs.0.00, status ` +
  `'${inv?.paymentStatus ?? "-"}' -> 'unpaid', PDF re-stamped NOT PAID`,
);
console.log(
  `\n  ${sale.dealerCode} ${sale.dealerName} balance ` +
  `Rs.${balBefore.toFixed(2)} -> Rs.${(balBefore - sale.total).toFixed(2)}`,
);
console.log(
  `  Day Book loses Rs.${receiptTotal.toFixed(2)} of counter cash on ${sale.saleDate}; ` +
  `AR Aging gains Rs.${sale.total.toFixed(2)}, aging from the invoice due date ` +
  `${inv?.dueDate ?? "(none)"}.`,
);

if (!APPLY) {
  console.log("\nDRY RUN - nothing written. Re-run with --apply.");
  await pgClient.end();
  process.exit(0);
}

// ── Apply ──
let removed = 0;
await pgClient.begin(async (_tx) => {
  const tx = _tx as unknown as typeof pgClient;

  // Re-read under lock: mode and total are what the postings are built from.
  const [live] = (await tx`
    SELECT payment_mode::text AS mode, status::text AS status,
           grand_total::float8 AS total, gp_no AS "gpNo"
      FROM direct_sales WHERE id = ${sale.id}::uuid FOR UPDATE
  `) as any[];
  if (!live) throw new Error("Sale vanished");
  if (live.mode !== "cash") throw new Error(`Mode changed to '${live.mode}' under us`);
  if (live.status === "cancelled") throw new Error("Sale was cancelled under us");

  const againPosted = await ledgerPostedForSale(tx, sale.id);
  if (againPosted > 0.001)
    throw new Error("A ledger posting appeared under us; aborting to avoid double billing");

  await tx`
    UPDATE direct_sales
       SET payment_mode = 'credit'::payment_mode,
           updated_at   = now()
     WHERE id = ${sale.id}::uuid
  `;

  // The cash that was never taken.
  removed = await reverseCounterCashReceipt(tx, sale.id);

  // What the agent now owes. Same helper, same shape, as a credit pass
  // issued through the counter screen.
  await debitDealerBalance(
    tx,
    sale.customerId,
    live.total,
    sale.id,
    `Gate pass ${live.gpNo ?? sale.id} (payment mode corrected from cash to credit)`,
    sale.officerId,
  );
});

console.log(`\nAPPLIED. Counter cash receipt removed: Rs.${removed.toFixed(2)}`);

// ── Step 4, outside the transaction: let the mint re-derive the invoice ──
const reissue = await reissueDirectSaleInvoiceIfExists(sale.id);
console.log("Invoice reissue:", reissue);

// ── Verify ──
const [after] = (await pgClient`
  SELECT ds.payment_mode::text AS mode,
         COALESCE((SELECT SUM(CASE WHEN dl.type='debit' THEN dl.amount ELSE -dl.amount END)
                     FROM dealer_ledger dl WHERE dl.reference_id = ds.id
                       AND dl.reference_type IN ('order','refund')), 0)::float8 AS "ledgerDr",
         COALESCE((SELECT SUM(p.amount) FROM payments p
                    WHERE p.mode='cash'
                      AND p.notes = 'Counter cash for gate pass ' || COALESCE(ds.gp_no, ds.id::text)
                  ), 0)::float8 AS "cashRcpt",
         (SELECT i.paid_amount::float8 FROM invoices i WHERE i.order_id = ds.id) AS "invPaid",
         (SELECT i.payment_status::text FROM invoices i WHERE i.order_id = ds.id) AS "invStatus",
         (SELECT i.due_date::text FROM invoices i WHERE i.order_id = ds.id) AS "invDue",
         (SELECT i.pdf_url IS NOT NULL FROM invoices i WHERE i.order_id = ds.id) AS "hasPdf"
    FROM direct_sales ds WHERE ds.id = ${sale.id}::uuid
`) as any[];
console.log("\n== After ==");
console.table([{
  mode: after.mode,
  ledgerDr: after.ledgerDr,
  cashRcpt: after.cashRcpt,
  invPaid: after.invPaid,
  invStatus: after.invStatus,
  invDue: after.invDue,
  hasPdf: after.hasPdf,
  billedInFull: Math.abs(after.ledgerDr - sale.total) < 0.01,
}]);

console.log(
  `\n${sale.dealerCode} ${sale.dealerName} balance: ` +
  `Rs.${(await dealerBalance()).toFixed(2)}`,
);

// Every recent agent pass, and what backs it, so no mode is left unbacked.
const passes = (await pgClient`
  SELECT ds.gp_no AS "gpNo", ds.sale_date::text AS date,
         ds.payment_mode::text AS mode, ds.grand_total::float8 AS total,
         COALESCE((SELECT SUM(CASE WHEN dl.type='debit' THEN dl.amount ELSE -dl.amount END)
                     FROM dealer_ledger dl WHERE dl.reference_id = ds.id
                       AND dl.reference_type IN ('order','refund')), 0)::float8 AS "ledgerDr",
         COALESCE((SELECT SUM(p.amount) FROM payments p
                    WHERE p.mode='cash'
                      AND p.notes = 'Counter cash for gate pass ' || COALESCE(ds.gp_no, ds.id::text)
                  ), 0)::float8 AS "cashRcpt",
         COALESCE((SELECT SUM(rp.amount - rp.amount_refunded) FROM razorpay_payments rp
                    WHERE rp.direct_sale_id = ds.id AND rp.kind='gate_pass'
                      AND rp.status IN ('paid','refunded')), 0)::float8 AS "qrIn"
    FROM direct_sales ds
   WHERE ds.customer_type='agent' AND ds.status='confirmed' AND ds.grand_total > 0
   ORDER BY ds.sale_date DESC
   LIMIT 12
`) as any[];
console.log("\n== Recent confirmed agent passes: backing ==");
console.table(passes.map((p) => ({
  ...p,
  backed:
    p.mode === "credit" || p.mode === "wallet"
      ? (Math.abs(p.ledgerDr - p.total) < 0.01 ? "ledger" : "MISMATCH")
      : p.mode === "cash"
        ? (Math.abs(p.cashRcpt - p.total) < 0.01 ? "cash receipt" : "MISMATCH")
        : (Math.abs(p.qrIn - p.total) < 0.01 ? "QR" : "QR unpaid"),
})));

await pgClient.end();
