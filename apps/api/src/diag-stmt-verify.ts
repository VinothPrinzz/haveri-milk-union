// Read-only: run the REAL statement loader against prod for a few dealers
// and assert the accounting identity + rollup consistency.
import { pgClient } from "./lib/db.js";
import { loadStatement } from "./routes/finance-dealer-statements.js";

const ok = (x: number, y: number) => Math.abs(x - y) < 0.01;

async function main() {
  const busiest = await pgClient`
    SELECT o.dealer_id AS id, count(*)::int AS n
      FROM orders o
     WHERE o.created_at >= current_date - 30
       AND o.status IN ('confirmed','dispatched','delivered')
     GROUP BY 1 ORDER BY 2 DESC LIMIT 4
  `;

  const to = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
  const from = to.slice(0, 8) + "01";

  const t0 = Date.now();
  for (const b of busiest as any[]) {
    const s: any = await loadStatement(b.id, from, to);
    if (!s) { console.log(`✗ ${b.id} not found`); continue; }
    const t = s.totals;
    const identity = s.openingBalance + t.credits - t.debits;
    const rollupDr = s.daily.reduce((a: number, d: any) => a + d.totalDr, 0);
    const rollupCr = s.daily.reduce((a: number, d: any) => a + d.totalCr, 0);
    const kindsDr = t.invoices + t.refunds + t.adjustmentsDr;
    const kindsCr = t.payments + t.topups + t.adjustmentsCr;

    console.log(`\n══ ${s.dealer.code} — ${s.dealer.name} (${from}..${to}) ══`);
    console.log(`  opening ${s.openingBalance.toFixed(2)}  Dr ${t.debits.toFixed(2)}  Cr ${t.credits.toFixed(2)}  closing ${t.closingBalance.toFixed(2)}`);
    console.log(`  invoices ${t.invoices.toFixed(2)} | payments ${t.payments.toFixed(2)} | topups ${t.topups.toFixed(2)} | refunds ${t.refunds.toFixed(2)} | adjDr ${t.adjustmentsDr.toFixed(2)} adjCr ${t.adjustmentsCr.toFixed(2)}`);
    console.log(`  rows ${s.rows.length}, days ${s.daily.length}, wallet ₹${s.wallet.balance}`);
    console.log(`  identity opening+Cr-Dr == closing : ${ok(identity, t.closingBalance) ? "✓" : `✗ ${identity} vs ${t.closingBalance}`}`);
    console.log(`  daily rollup Dr / Cr tie          : ${ok(rollupDr, t.debits) && ok(rollupCr, t.credits) ? "✓" : `✗ ${rollupDr}/${rollupCr} vs ${t.debits}/${t.credits}`}`);
    console.log(`  kind buckets sum to Dr / Cr       : ${ok(kindsDr, t.debits) && ok(kindsCr, t.credits) ? "✓" : `✗ ${kindsDr}/${kindsCr} vs ${t.debits}/${t.credits}`}`);
    let chain = true, prev = s.openingBalance;
    for (const d of s.daily) {
      if (!ok(d.opening, prev) || !ok(d.closing, d.opening + d.totalCr - d.totalDr)) chain = false;
      prev = d.closing;
    }
    console.log(`  per-day opening/closing chain     : ${chain ? "✓" : "✗"}`);
    console.log(`  dates inside period               : ${s.rows.every((r: any) => r.voucherDate >= from && r.voucherDate <= to) ? "✓" : "✗"}`);
    console.log(`  rows sorted by date               : ${s.rows.every((r: any, i: number) => i === 0 || s.rows[i - 1].voucherDate <= r.voucherDate) ? "✓" : "✗"}`);

    if (s.daily.length) {
      console.log("  last 5 active days:");
      for (const d of s.daily.slice(-5)) {
        console.log(`    ${d.date}  open ${d.opening.toFixed(2).padStart(11)}  inv ${d.invoiceDr.toFixed(2).padStart(10)}  pay ${d.paymentCr.toFixed(2).padStart(10)}  top ${d.topupCr.toFixed(2).padStart(9)}  adj ${(d.adjustmentCr - d.adjustmentDr).toFixed(2).padStart(8)}  close ${d.closing.toFixed(2).padStart(11)}`);
      }
    }
    if (s.rows.length) {
      console.log("  sample vouchers:");
      for (const r of s.rows.slice(0, 5)) {
        console.log(`    ${r.voucherDate} ${String(r.kind).padEnd(10)} ${String(r.voucherNo).padEnd(20)} ${r.type === "debit" ? "Dr" : "Cr"} ${r.amount.toFixed(2).padStart(10)}  ${String(r.particulars).slice(0, 58)}`);
      }
    }
  }
  console.log(`\n${busiest.length} statements in ${Date.now() - t0}ms`);

  // A dealer with cheque / adjustment history, if one exists.
  const [adjD] = await pgClient`
    SELECT dl.dealer_id AS id FROM dealer_ledger dl
     LEFT JOIN ledger_adjustments a ON a.ledger_entry_id = dl.id
     WHERE dl.voucher_no LIKE 'CB-%' OR dl.voucher_no LIKE 'CC-%'
        OR dl.voucher_no LIKE 'CX-%' OR a.id IS NOT NULL
     LIMIT 1
  `;
  if (adjD) {
    const s: any = await loadStatement((adjD as any).id, "2020-01-01", to);
    const adj = s.rows.filter((r: any) => r.kind === "adjustment");
    console.log(`\nadjustment dealer ${s.dealer.code}: ${adj.length} adjustment rows`);
    for (const r of adj.slice(0, 5)) console.log(`  ${r.voucherDate} ${r.voucherNo} ${r.type} ${r.amount} ${String(r.particulars).slice(0, 60)}`);
  } else {
    console.log("\nno cheque/manual adjustment rows in prod yet");
  }

  await pgClient.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
