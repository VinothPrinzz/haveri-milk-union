// ═══════════════════════════════════════════════════════════════════════
// diag-delete-t1eh-wrong-receipts.ts
//
// An admin keyed four RTGS receipts against T1EH-RELIANCE RETAIL LTD on
// 2026-08-27 (13:30-13:38 IST) using the wrong invoices/amounts, and wants
// them removed so they can be re-entered correctly.
//
//   RC-INV-HMU-2026-2D21715E-000000  20 Aug  Rs.1,340.84  INV-...-2D21715E
//   RC-INV-HMU-2026-D01D770F-600000  24 Aug  Rs.1,662.36  INV-...-D01D770F
//   RC-INV-HMU-2026-89B557A6-600000  24 Aug  Rs.1,543.00  INV-...-89B557A6
//   RC-INV-HMU-2026-993D51B6-600000  24 Aug  Rs.1,686.32  INV-...-993D51B6
//
// Record Payment (routes/finance.ts) writes three things per receipt: a
// `payments` row, a `dealer_ledger` credit keyed to that payment id, and an
// incremented invoices.paid_amount / payment_status. All three come back out:
//
//   1. DELETE the dealer_ledger row  (reference_id = payment id)
//   2. DELETE the payments row       (the ONE receipts rail - Day Book,
//                                     Dealer Statements and AR Aging all
//                                     read it, so the money must not linger)
//   3. refreshInvoiceSettlement(orderId) - re-derives paid_amount and
//      payment_status from the money rails rather than subtracting by hand,
//      so the invoice lands wherever the remaining rails actually put it.
//
// DELETE rather than a contra entry, because `payments` has CHECK (amount > 0)
// and no reversal concept - the same thing diag-fix-gp0051-cash-to-credit.ts
// does when a mode change unwinds a counter-cash receipt.
//
// Nothing else hangs off these rows: `cheques` is the only table with an FK
// to payments and these are rtgs-mode, so it holds none of them.
//
// Idempotent: rows already gone are skipped, and the settlement refresh
// recomputes from scratch.
//
// USAGE (from apps/api):
//   npx tsx src/diag-delete-t1eh-wrong-receipts.ts           # dry run
//   npx tsx src/diag-delete-t1eh-wrong-receipts.ts --apply
// ═══════════════════════════════════════════════════════════════════════
import { pgClient } from "./lib/db.js";
import { refreshInvoiceSettlement } from "./lib/invoice-settlement.js";

const APPLY = process.argv.includes("--apply");

const VOUCHERS = [
  "RC-INV-HMU-2026-2D21715E-000000",
  "RC-INV-HMU-2026-D01D770F-600000",
  "RC-INV-HMU-2026-89B557A6-600000",
  "RC-INV-HMU-2026-993D51B6-600000",
];

// Guard rails: the exact rows this script is allowed to touch. Anything the
// lookup turns up outside these sets aborts rather than deleting blind.
const DEALER_NAME = "T1EH-RELIANCE RETAIL LTD";
const PAYMENT_IDS = new Set([
  "30a119bb-ad34-457d-9dbc-24b968ab0506",
  "5bc69177-b9ad-4a1e-a494-147659989c7a",
  "b197d39d-3707-4a66-896c-1cb9fe7fb384",
  "fb288b24-c4f3-4e1e-afe1-ebb17cf69d42",
]);

async function main() {
  const rows = await pgClient`
    SELECT dl.id            AS ledger_id,
           dl.voucher_no    AS voucher_no,
           dl.amount::float8 AS ledger_amount,
           p.id             AS payment_id,
           p.amount::float8 AS payment_amount,
           p.mode::text     AS mode,
           p.received_date  AS received_date,
           p.reference      AS reference,
           d.name           AS dealer,
           i.id             AS invoice_id,
           i.invoice_number AS invoice_number,
           i.order_id       AS order_id,
           i.total_amount::float8 AS invoice_total,
           i.paid_amount::float8  AS invoice_paid,
           i.payment_status::text AS invoice_status
      FROM dealer_ledger dl
      JOIN dealers  d ON d.id = dl.dealer_id
      JOIN payments p ON p.id = dl.reference_id
      LEFT JOIN invoices i ON i.id = p.invoice_id
     WHERE dl.voucher_no = ANY(${VOUCHERS})
     ORDER BY p.created_at
  `;

  if (rows.length === 0) {
    console.log("Nothing to do - none of the four vouchers are present.");
    await pgClient.end();
    return;
  }

  for (const r of rows as any[]) {
    if (r.dealer !== DEALER_NAME) {
      throw new Error(`Refusing: ${r.voucher_no} belongs to ${r.dealer}, not ${DEALER_NAME}`);
    }
    if (!PAYMENT_IDS.has(r.payment_id)) {
      throw new Error(`Refusing: ${r.voucher_no} points at unexpected payment ${r.payment_id}`);
    }
    if (Math.abs(r.ledger_amount - r.payment_amount) > 0.005) {
      throw new Error(`Refusing: ${r.voucher_no} ledger ${r.ledger_amount} != payment ${r.payment_amount}`);
    }
  }

  // A cheque row would block the delete (FK ON DELETE RESTRICT) and would
  // also need unwinding in the Cheque Register; none of these are cheques,
  // but check rather than assume.
  const chq = await pgClient`
    SELECT id, payment_id FROM cheques
     WHERE payment_id = ANY(${[...PAYMENT_IDS]}::uuid[])
  `;
  if (chq.length > 0) {
    throw new Error(`Refusing: ${chq.length} cheque row(s) hang off these payments`);
  }

  console.log(`${APPLY ? "APPLYING" : "DRY RUN"} - ${rows.length} receipt(s) on ${DEALER_NAME}\n`);
  console.table((rows as any[]).map((r) => ({
    voucher: r.voucher_no,
    date: String(r.received_date).slice(0, 10),
    amount: r.payment_amount,
    mode: r.mode,
    utr: r.reference,
    invoice: r.invoice_number,
    "invoice paid now": r.invoice_paid,
    "invoice status now": r.invoice_status,
  })));

  const total = (rows as any[]).reduce((s, r) => s + r.payment_amount, 0);
  console.log(`Total coming off the books: Rs.${total.toFixed(2)}\n`);

  if (!APPLY) {
    console.log("Dry run - nothing written. Re-run with --apply to delete.");
    await pgClient.end();
    return;
  }

  await pgClient.begin(async (_tx) => {
    const tx = _tx as unknown as typeof pgClient;
    for (const r of rows as any[]) {
      await tx`DELETE FROM dealer_ledger WHERE id = ${r.ledger_id}::uuid`;
      await tx`DELETE FROM payments      WHERE id = ${r.payment_id}::uuid`;
      console.log(`  deleted ${r.voucher_no}  Rs.${r.payment_amount.toFixed(2)}`);
    }
  });

  // Settlement refresh runs outside the transaction: it reads the committed
  // state and never throws, so a hiccup here cannot roll the deletes back.
  for (const r of rows as any[]) {
    if (!r.order_id) continue;
    await refreshInvoiceSettlement(r.order_id);
  }

  const after = await pgClient`
    SELECT invoice_number, total_amount::float8 AS total,
           paid_amount::float8 AS paid, payment_status::text AS status
      FROM invoices
     WHERE id = ANY(${(rows as any[]).map((r) => r.invoice_id).filter(Boolean)}::uuid[])
     ORDER BY invoice_number
  `;
  console.log("\n── invoices after ──");
  console.table(after);

  const leftover = await pgClient`
    SELECT count(*)::int AS n FROM dealer_ledger WHERE voucher_no = ANY(${VOUCHERS})
  `;
  console.log(`Ledger rows still carrying those vouchers: ${(leftover[0] as any).n}`);
  await pgClient.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
