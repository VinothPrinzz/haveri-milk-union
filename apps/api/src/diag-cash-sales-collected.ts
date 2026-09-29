// Read-only: do the money rows on the sales grids equal money collected?
//
// Since every amount is anchored on the document total, three things must hold
// for each route and for the grand total:
//   Milk + Product == Total,  and  Total == sum of the document totals.
//
//   npx tsx apps/api/src/diag-cash-sales-collected.ts 2026-08-01 2026-08-31
//
// Covers Cash Sales (B4) and both sides of the Sales Register (B6) - the
// credit side is the only one that exercises the employee_orders arm.
import { pgClient } from "./lib/db.js";
import { buildSalesGrid, loadReportConfig, type SaleType } from "./routes/sales-reports.js";

const from = process.argv[2] ?? "2026-08-01";
const to = process.argv[3] ?? "2026-08-31";
const f = (v: number) => v.toFixed(2).padStart(16);
const r2 = (v: number) => Math.round(v * 100) / 100;

async function check(label: string, saleType: SaleType, collectedModesOnly: boolean) {
  const cfg = await loadReportConfig();
  const g: any = await buildSalesGrid({ q: { from, to }, cfg, saleType, collectedModesOnly });
  const t = g.totals;
  console.log(`\n== ${label} ==`);
  console.log(`  Milk ₹                       ${f(t.milkAmount)}`);
  console.log(`  Product ₹                    ${f(t.productAmount)}`);
  console.log(`  Total ₹                      ${f(t.total)}`);
  console.log(`  (check) sum of doc totals     ${f(t.collected)}`);

  const split = r2(t.milkAmount + t.productAmount);
  const splitOk = Math.abs(split - t.total) < 0.005;
  const collOk = Math.abs(t.total - t.collected) < 0.005;
  console.log(`  Milk + Product == Total       : ${splitOk ? "yes" : `NO (${split} vs ${t.total})`}`);
  console.log(`  Total == money collected      : ${collOk ? "yes" : `NO (off by ${(t.total - t.collected).toFixed(2)})`}`);

  let badSplit = 0, badColl = 0;
  for (const rt of g.routes) {
    if (Math.abs(r2(rt.milkAmount + rt.productAmount) - rt.total) > 0.005) badSplit++;
    if (Math.abs(rt.total - rt.collected) > 0.005) badColl++;
  }
  const n = g.routes.length;
  console.log(`  per route split ties          : ${badSplit === 0 ? `all ${n}` : `${n - badSplit}/${n}`}`);
  console.log(`  per route collected ties      : ${badColl === 0 ? `all ${n}` : `${n - badColl}/${n}`}`);
}

async function main() {
  await check("Cash Sales (B4)", "cash", true);
  await check("Sales Register, cash side", "cash", false);
  await check("Sales Register, credit side", "credit", false);
  console.log();
  await pgClient.end();
}

main().catch(async (e) => { console.error(e); await pgClient.end(); process.exit(1); });
