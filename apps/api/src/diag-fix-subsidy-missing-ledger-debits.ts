// ═══════════════════════════════════════════════════════════════════════
// Post the two dealer_ledger debits that the cash branch of
// routes/subsidy-indents.ts never wrote, and re-derive the invoices.
//
//   A4  A B PARANDEKAR   order 617c1bb0  Rs.446.60  (subsidy line appended
//                        to a live credit order on 2026-08-01, no delta debit)
//   M61 MEGHARAJ TOTAGER order ac3f3ff3  Rs. 44.66  (fresh cash order on
//                        2026-08-05, settled from a Rs.50 wallet top-up)
//
// Why a ledger DEBIT and not a cash receipt: both customers had already paid
// the money into their balance, so the correct posting is a drawdown, not a
// second receipt. The Dealer Statement proves the target figure — it derives
// from orders and payments and never reads dealer_ledger for order settlement,
// and it already shows A4 at 23,603.63 Cr and M61 at 10.68 Cr. The ledger reads
// exactly 446.61 and 44.66 higher, and AR Aging shows exactly 446.60 and 44.66
// open. One missing debit per order causes both. Adding a receipt instead would
// double-count against M61's top-up, which the statement already credits.
//
// M61's order also carries payment_mode='cash', the only such dealer order in
// 10,846. It is ledger-settled, so it is flipped to 'credit' to match every
// other balance-settled order; cancel-order.ts branches on that column and has
// no 'cash' branch, so leaving it would silently skip the reversal on a cancel.
//
// Idempotent: re-running finds the correction rows and does nothing.
// ═══════════════════════════════════════════════════════════════════════
import { pgClient } from "./lib/db.js";
import { refreshInvoiceSettlement } from "./lib/invoice-settlement.js";

const APPLY = process.argv.includes("--apply");

const FIXES = [
  {
    code: "A4",
    orderId: "617c1bb0-acc3-4d4a-aa57-ab745a5d5c0e",
    amount: 446.6,
    flipPaymentMode: false,
    note: "subsidy line appended to a live order, delta never debited",
  },
  {
    code: "M61",
    orderId: "ac3f3ff3-93c1-4964-a21c-9e1a97c3229f",
    amount: 44.66,
    flipPaymentMode: true,
    note: "cash-mode subsidy order, settled from wallet top-up, never debited",
  },
];

/** Same running-balance maths as currentBalance() in subsidy-indents.ts. */
async function balanceOf(tx: typeof pgClient, dealerId: string): Promise<number> {
  const [b] = await tx`
    SELECT
      COALESCE(d.opening_balance, 0)
      + COALESCE((SELECT SUM(CASE WHEN dl.type = 'credit'
                                   AND COALESCE(dl.voucher_type,'') <> 'Opening'
                                  THEN dl.amount ELSE 0 END)
                    FROM dealer_ledger dl WHERE dl.dealer_id = d.id), 0)
      - COALESCE((SELECT SUM(CASE WHEN dl.type = 'debit'
                                   AND COALESCE(dl.voucher_type,'') <> 'Opening'
                                  THEN dl.amount ELSE 0 END)
                    FROM dealer_ledger dl WHERE dl.dealer_id = d.id), 0)
      AS bal
    FROM dealers d WHERE d.id = ${dealerId}::uuid
  `;
  return parseFloat((b as any)!.bal);
}

async function main() {
  console.log(APPLY ? "MODE: APPLY\n" : "MODE: DRY RUN (pass --apply to write)\n");

  for (const fix of FIXES) {
    const [ord] = await pgClient`
      SELECT o.id, o.dealer_id, o.payment_mode::text AS payment_mode, o.delivery_date,
             o.grand_total::text AS grand_total, o.status::text AS status,
             d.code, d.name
        FROM orders o JOIN dealers d ON d.id = o.dealer_id
       WHERE o.id = ${fix.orderId}::uuid
    `;
    if (!ord) { console.log(`${fix.code}: order not found, skipped`); continue; }

    const description = `Subsidy indent ${fix.orderId} (posting correction)`;
    const [dupe] = await pgClient`
      SELECT id FROM dealer_ledger
       WHERE reference_id = ${fix.orderId}::uuid AND description = ${description} LIMIT 1
    `;
    const [inv] = await pgClient`
      SELECT invoice_number, total_amount::text AS total, paid_amount::text AS paid,
             payment_status::text AS status
        FROM invoices WHERE order_id = ${fix.orderId}::uuid LIMIT 1
    `;
    const before = await balanceOf(pgClient, (ord as any).dealer_id);

    console.log(`── ${fix.code} ${(ord as any).name}`);
    console.log(`   ${fix.note}`);
    console.log(`   order      ${fix.orderId}  ${(ord as any).status}  mode=${(ord as any).payment_mode}`);
    console.log(`   invoice    ${(inv as any)?.invoice_number}  total ${(inv as any)?.total}  paid ${(inv as any)?.paid}  (${(inv as any)?.status})`);
    console.log(`   ledger     ${before.toFixed(2)}  ->  ${(before - fix.amount).toFixed(2)}  (debit ${fix.amount.toFixed(2)})`);
    if (dupe) { console.log(`   ALREADY CORRECTED, skipping\n`); continue; }
    if (!APPLY) { console.log(`   (dry run, nothing written)\n`); continue; }

    await pgClient.begin(async (_tx) => {
      const tx = _tx as unknown as typeof pgClient;
      // Re-read the balance under the transaction so a concurrent indent
      // cannot make two rows stamp the same running balance.
      const bal = await balanceOf(tx, (ord as any).dealer_id);
      await tx`
        INSERT INTO dealer_ledger
          (dealer_id, type, amount, reference_id, reference_type,
           voucher_type, voucher_date, description, balance_after, performed_by)
        VALUES
          (${(ord as any).dealer_id}::uuid, 'debit', ${fix.amount.toFixed(2)}::numeric,
           ${fix.orderId}::uuid, 'order'::ledger_ref_type,
           'Invoice', (now() AT TIME ZONE 'Asia/Kolkata')::date,
           ${description}, ${(bal - fix.amount).toFixed(2)}::numeric, NULL)
      `;
      if (fix.flipPaymentMode) {
        await tx`
          UPDATE orders SET payment_mode = 'credit', updated_at = now()
           WHERE id = ${fix.orderId}::uuid AND payment_mode::text = 'cash'
        `;
      }
    });

    await refreshInvoiceSettlement(fix.orderId);

    const [after] = await pgClient`
      SELECT i.invoice_number, i.total_amount::text AS total,
             i.paid_amount::text AS paid, i.payment_status::text AS status,
             o.payment_mode::text AS mode
        FROM invoices i JOIN orders o ON o.id = i.order_id
       WHERE i.order_id = ${fix.orderId}::uuid LIMIT 1
    `;
    const bal2 = await balanceOf(pgClient, (ord as any).dealer_id);
    console.log(`   WROTE      ledger now ${bal2.toFixed(2)}  |  invoice paid ${(after as any).paid} / ${(after as any).total} (${(after as any).status})  mode=${(after as any).mode}\n`);
  }

  await pgClient.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
