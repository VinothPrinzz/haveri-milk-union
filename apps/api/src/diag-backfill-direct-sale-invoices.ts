// ═══════════════════════════════════════════════════════════════════════
// diag-backfill-direct-sale-invoices.ts — mints the tax invoice for every
// direct sale that never got one.
//
// Until now a direct sale was only invoiced when somebody clicked its bill #
// on Recent Sales, and two whole kinds were refused outright: a VIP sample
// and any zero-value pass. Direct sales are now invoiced at creation and no
// kind is refused, so this recovers the history behind that change.
//
// Idempotent: generateDirectSaleInvoicePdfSync upserts on order_id, so a sale
// that already has an invoice is skipped here and would be harmless anyway —
// the invoice_number and the legal invoice_date survive a regeneration.
//
// CANCELLED sales are skipped: a cancelled counter sale keeps any invoice it
// already had (the record of what was issued survives) but must not have a
// new one minted for goods that went back on the shelf.
//
// USAGE (from apps/api):
//   npx tsx src/diag-backfill-direct-sale-invoices.ts          # dry run
//   npx tsx src/diag-backfill-direct-sale-invoices.ts --apply  # mint
// ═══════════════════════════════════════════════════════════════════════
import { pgClient } from "./lib/db.js";
import { generateDirectSaleInvoicePdfSync } from "./lib/invoice-pdf.js";

const APPLY = process.argv.includes("--apply");

const targets = await pgClient`
  SELECT ds.id::text            AS id,
         ds.gp_no               AS gp_no,
         ds.customer_type::text AS customer_type,
         ds.sale_date::text     AS sale_date,
         ds.grand_total::float8 AS grand_total
    FROM direct_sales ds
    LEFT JOIN invoices i ON i.order_id = ds.id
   WHERE i.order_id IS NULL
     AND ds.status <> 'cancelled'
   ORDER BY ds.sale_date, ds.created_at
`;

const byKind = new Map<string, number>();
for (const t of targets as any[]) {
  byKind.set(t.customer_type, (byKind.get(t.customer_type) ?? 0) + 1);
}

console.log(`${targets.length} direct sale(s) with no invoice`);
for (const [kind, n] of byKind) console.log(`  ${kind.padEnd(16)} ${n}`);

if (!APPLY) {
  console.log("\ndry run — re-run with --apply to mint");
  await pgClient.end();
  process.exit(0);
}

let ok = 0;
const failures: Array<{ id: string; error: string }> = [];

for (const t of targets as any[]) {
  try {
    const { invoiceNumber } = await generateDirectSaleInvoicePdfSync(t.id);
    ok++;
    console.log(
      `  ok  ${t.sale_date}  ${(t.gp_no ?? t.id.slice(0, 8)).padEnd(12)} ` +
        `${t.customer_type.padEnd(14)} Rs.${Number(t.grand_total).toFixed(2).padStart(10)}  ${invoiceNumber}`
    );
  } catch (err) {
    const message = String((err as Error)?.message ?? err);
    failures.push({ id: t.id, error: message });
    console.error(`  FAIL ${t.id}: ${message}`);
  }
}

console.log(`\nminted ${ok} / ${targets.length}; ${failures.length} failed`);
await pgClient.end();
