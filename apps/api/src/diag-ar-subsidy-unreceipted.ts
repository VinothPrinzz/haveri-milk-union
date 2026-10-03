// Read-only. Why do INV-HMU-2026-617C1BB0 (A4) and INV-HMU-2026-AC3F3FF3 (M61)
// sit in AR Aging when the dealer paid at indent time?
//
// Both are subsidy indents (routes/subsidy-indents.ts) recorded with a payment
// mode of cash / UPI-without-reference. That branch bills the line but posts NO
// receipt: no payments row, no dealer_ledger debit, no payment_reference. Since
// invoice-settlement.ts derives paid_amount from evidence on those three rails,
// the line can never settle. Only the 'credit' branch writes a ledger delta,
// which is why the other 487 live subsidy lines are clean.
import { pgClient } from "./lib/db.js";

async function main() {
  const rows = await pgClient`
    SELECT d.code, d.name, o.id AS order_id, o.order_date, o.payment_mode,
           o.payment_reference IS NOT NULL          AS has_ref,
           oi.line_total::text                      AS subsidy_line,
           oi.created_at > o.created_at + interval '1 minute' AS appended_to_live_order,
           i.invoice_number,
           i.total_amount::text                     AS inv_total,
           i.paid_amount::text                      AS inv_paid,
           (i.total_amount - i.paid_amount)::text   AS gap,
           i.payment_status,
           (SELECT count(*)::int FROM dealer_ledger dl WHERE dl.reference_id = o.id) AS ledger_rows,
           (SELECT count(*)::int FROM payments p WHERE p.invoice_id = i.id)          AS receipt_rows
      FROM order_items oi
      JOIN orders   o ON o.id = oi.order_id
      JOIN dealers  d ON d.id = o.dealer_id
      JOIN invoices i ON i.order_id = o.id
     WHERE oi.product_name ILIKE '%Subsidy%'
       AND o.status <> 'cancelled'
       AND i.total_amount - i.paid_amount > 0.01
     ORDER BY o.order_date
  `;
  console.log(`subsidy-carrying invoices still short: ${rows.length}`);
  for (const r of rows) console.log(" ", JSON.stringify(r));

  // The money the dealers actually handed over, and where it landed instead.
  for (const code of ["M61", "A4"]) {
    const [d] = await pgClient`SELECT id, code, name FROM dealers WHERE code = ${code}`;
    if (!d) continue;
    const [bal] = await pgClient`
      SELECT balance_after::text AS balance, description, created_at
        FROM dealer_ledger WHERE dealer_id = ${d.id}::uuid
       ORDER BY created_at DESC LIMIT 1`;
    console.log(`${code} running balance:`, JSON.stringify(bal));
  }

  await pgClient.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
