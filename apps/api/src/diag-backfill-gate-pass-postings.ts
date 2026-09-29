// ═══════════════════════════════════════════════════════════════════════
// diag-backfill-gate-pass-postings.ts
//
// Gate passes issued before the payment modes started posting money. Every
// one of them wrote a sale row and nothing else, so:
//
//   • a pass on CREDIT never billed the agent — no dealer_ledger debit, so
//     their balance and outstanding never moved (GP-0045 + GP-0046,
//     ₹23,999.08 on 2026-08-12)
//   • a pass on CASH never recorded the notes as a receipt, so the Day Book
//     never saw that money arrive
//
// Both now post at issue (routes/direct-sales.ts), and the dealer statement
// bills every gate pass in its section 1b. That last part is what makes this
// backfill necessary rather than cosmetic: without it, the historical cash
// passes would show on an agent's statement as a debit they never paid.
//
// UPI passes need nothing — the counter QR already wrote razorpay_payments,
// and the statement reads those directly (section 2b).
//
// Cancelled sales are skipped: there is nothing to post for a sale that does
// not stand.
//
// Idempotent. A sale that already carries its posting is left alone, so this
// can be re-run safely.
//
// USAGE (from apps/api):
//   npx tsx src/diag-backfill-gate-pass-postings.ts          # dry run
//   npx tsx src/diag-backfill-gate-pass-postings.ts --apply
// ═══════════════════════════════════════════════════════════════════════
import { pgClient } from "./lib/db.js";

const APPLY = process.argv.includes("--apply");

type Sale = {
  id: string;
  gpNo: string | null;
  saleDate: string;
  mode: string;
  total: number;
  dealerId: string;
  dealerCode: string | null;
  dealerName: string | null;
  ledgerPosted: number;
  cashReceipts: number;
};

const sales = (await pgClient`
  SELECT ds.id::text            AS id,
         ds.gp_no               AS "gpNo",
         ds.sale_date::text     AS "saleDate",
         ds.payment_mode::text  AS mode,
         ds.grand_total::float8 AS total,
         ds.customer_id::text   AS "dealerId",
         d.code                 AS "dealerCode",
         d.name                 AS "dealerName",
         COALESCE((
           SELECT SUM(CASE WHEN dl.type = 'debit'  THEN  dl.amount
                           WHEN dl.type = 'credit' THEN -dl.amount
                           ELSE 0 END)
             FROM dealer_ledger dl
            WHERE dl.reference_id = ds.id
              AND dl.reference_type IN ('order', 'refund')
         ), 0)::float8 AS "ledgerPosted",
         COALESCE((
           SELECT SUM(p.amount)
             FROM payments p
            WHERE p.mode = 'cash'
              AND p.notes = 'Counter cash for gate pass ' || COALESCE(ds.gp_no, ds.id::text)
         ), 0)::float8 AS "cashReceipts"
    FROM direct_sales ds
    JOIN dealers d ON d.id = ds.customer_id
   WHERE ds.customer_type = 'agent'
     AND ds.status = 'confirmed'
     AND ds.grand_total > 0
   ORDER BY ds.sale_date, ds.created_at
`) as Sale[];

const needsLedger = sales.filter(
  (s) => (s.mode === "credit" || s.mode === "wallet") && s.ledgerPosted <= 0.001,
);
const needsCash = sales.filter((s) => s.mode === "cash" && s.cashReceipts <= 0.001);

console.log(`Confirmed agent gate passes: ${sales.length}`);
console.log(`\n── Missing ledger debit (wallet / credit) — ${needsLedger.length} ──`);
console.table(
  needsLedger.map((s) => ({
    gpNo: s.gpNo, date: s.saleDate, mode: s.mode,
    dealer: `${s.dealerCode ?? ""} ${s.dealerName ?? ""}`.trim(),
    total: s.total,
  })),
);
console.log(`Total to bill: ₹${needsLedger.reduce((t, s) => t + s.total, 0).toFixed(2)}`);

console.log(`\n── Missing counter cash receipt — ${needsCash.length} ──`);
console.table(
  needsCash.map((s) => ({
    gpNo: s.gpNo, date: s.saleDate,
    dealer: `${s.dealerCode ?? ""} ${s.dealerName ?? ""}`.trim(),
    total: s.total,
  })),
);
console.log(`Total to receipt: ₹${needsCash.reduce((t, s) => t + s.total, 0).toFixed(2)}`);

if (!APPLY) {
  console.log("\nDRY RUN — nothing written. Re-run with --apply.");
  await pgClient.end();
  process.exit(0);
}

let ledgerWritten = 0;
let cashWritten = 0;

await pgClient.begin(async (tx: any) => {
  // Oldest first, and balance_after is recomputed per row inside the
  // transaction, so a dealer with two passes gets a running balance that
  // reads correctly down their ledger rather than two rows stamped alike.
  for (const s of needsLedger) {
    const [bal] = (await tx`
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
      FROM dealers d WHERE d.id = ${s.dealerId}::uuid
    `) as any[];
    const balanceAfter = parseFloat(bal.bal) - s.total;

    await tx`
      INSERT INTO dealer_ledger
        (dealer_id, type, amount, reference_id, reference_type,
         voucher_type, voucher_date, description, balance_after, performed_by)
      VALUES
        (${s.dealerId}::uuid, 'debit', ${s.total.toFixed(2)}::numeric,
         ${s.id}::uuid, 'order'::ledger_ref_type,
         'Invoice', ${s.saleDate}::date,
         ${`Gate pass ${s.gpNo ?? s.id} (backfilled)`},
         ${balanceAfter.toFixed(2)}::numeric, NULL)
    `;
    ledgerWritten++;
  }

  for (const s of needsCash) {
    await tx`
      INSERT INTO payments
        (dealer_id, received_date, amount, mode, reference, invoice_id, received_by, notes)
      VALUES
        (${s.dealerId}::uuid, ${s.saleDate}::date,
         ${s.total.toFixed(2)}::numeric, 'cash',
         ${s.gpNo ?? `GP:${s.id.slice(0, 8)}`},
         (SELECT i.id FROM invoices i WHERE i.order_id = ${s.id}::uuid LIMIT 1),
         NULL,
         ${`Counter cash for gate pass ${s.gpNo ?? s.id}`})
    `;
    cashWritten++;
  }
});

console.log(`\nAPPLIED: ${ledgerWritten} ledger debit(s), ${cashWritten} cash receipt(s).`);

// ── Verify ──
const [after] = (await pgClient`
  SELECT
    (SELECT count(*)::int FROM direct_sales ds
      WHERE ds.customer_type = 'agent' AND ds.status = 'confirmed'
        AND ds.grand_total > 0
        AND ds.payment_mode::text IN ('wallet','credit')
        AND NOT EXISTS (SELECT 1 FROM dealer_ledger dl
                         WHERE dl.reference_id = ds.id AND dl.reference_type = 'order')
    ) AS "creditStillUnposted",
    (SELECT count(*)::int FROM direct_sales ds
      WHERE ds.customer_type = 'agent' AND ds.status = 'confirmed'
        AND ds.grand_total > 0
        AND ds.payment_mode::text = 'cash'
        AND NOT EXISTS (SELECT 1 FROM payments p
                         WHERE p.mode = 'cash'
                           AND p.notes = 'Counter cash for gate pass ' || COALESCE(ds.gp_no, ds.id::text))
    ) AS "cashStillUnreceipted"
`) as any[];
console.log("Remaining unposted:", after);

await pgClient.end();
