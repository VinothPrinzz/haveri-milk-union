// Checks the DTC bill arithmetic against the union's Consolidated DTC Bill
// (Belgaum, July 2026) and a few edge cases. No database needed.
//
// USAGE (from apps/api):  npx tsx src/check-dtc-calc.ts
import {
  billTotals, financialYear, segmentAmount, tdsPercent, termsRanges,
  type LineLike, type Segment, type TermsRow,
} from "./lib/dtc.js";

let failures = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(got)}${ok ? "" : ` (want ${JSON.stringify(want)})`}`);
}

function seg(billingType: Segment["billingType"], days: number, kmPerDay: number, rate: number, qty: number): Segment {
  const s: Segment = {
    key: "k", termsId: "t", from: "2026-07-01", to: "2026-07-31",
    billingType, rate, kmPerDay, autoDays: days, daysOverride: null, qty, amount: 0,
  };
  s.amount = segmentAmount(s);
  return s;
}
const ded = (amount: number, head = "km"): LineLike => ({ kind: "deduction", head, amount });
const earn = (amount: number, head = "extra_km"): LineLike => ({ kind: "earning", head, amount });

// ── Rows of the Belgaum July 2026 bill (cost per litre on the gross, as printed) ──
{
  const t = billTotals([seg("km", 31, 300, 12.79, 48184)], [ded(247 * 12.79)], "gross");
  eq("Athani gross", t.gross, 118947);
  eq("Athani deductions", t.totalDeductions, 3159);
  eq("Athani net", t.net, 115788);
  eq("Athani cost/ltr", t.costPerLitre, 2.47);
}
{
  const t = billTotals([seg("km", 31, 197, 23.68, 63842)], [ded(527 * 23.68)], "gross");
  eq("Bailhongal gross", t.gross, 144614);
  eq("Bailhongal net", t.net, 132135);
  eq("Bailhongal cost/ltr", t.costPerLitre, 2.27);
}
{
  const t = billTotals([seg("km", 31, 250, 21.64, 55750)], [earn(280 * 21.64)], "gross");
  eq("Ramdurga gross", t.gross, 167710);
  eq("Ramdurga other earnings", t.otherEarnings, 6059.2);
  eq("Ramdurga total earnings", t.totalEarnings, 173769);
  eq("Ramdurga cost/ltr (gross)", t.costPerLitre, 3.01);
  const te = billTotals([seg("km", 31, 250, 21.64, 55750)], [earn(280 * 21.64)], "total_earnings");
  eq("Ramdurga cost/ltr (total earnings)", te.costPerLitre, 3.12);
}
{
  const t = billTotals([seg("trip", 31, 0, 1200, 26684)], [ded(5000, "security_deposit")], "gross");
  eq("Evening-III gross", t.gross, 37200);
  eq("Evening-III net", t.net, 32200);
  eq("Evening-III cost/ltr", t.costPerLitre, 1.39);
}
{
  const t = billTotals([seg("km", 6, 90, 20.54, 8058)], [], "gross");
  eq("Torali gross (6 days)", t.gross, 11092);
  eq("Torali cost/ltr", t.costPerLitre, 1.38);
}
{
  const t = billTotals([seg("km", 31, 152, 20.98, 63901)], [ded(5 * 216, "crate")], "gross");
  eq("Gokak gross", t.gross, 98858);
  eq("Gokak net (5 crates × 216)", t.net, 97778);
}
{
  const t = billTotals([seg("km", 31, 175, 14.95, 43031)], [ded(1085 * 14.95)], "gross");
  eq("Kittur gross", t.gross, 81104);
  eq("Kittur net", t.net, 64883);
}
{
  const t = billTotals([seg("litre", 31, 0, 0.87, 3456)], [], "gross");
  eq("Litre basis 3456 L × 0.87", t.gross, 3007);
}

// ── Deductions larger than earnings carry forward ──
{
  const t = billTotals([seg("trip", 2, 0, 1000, 500)], [ded(3500, "advance")], "total_earnings");
  eq("negative net", t.net, -1500);
  eq("payable", t.payable, 0);
  eq("carry forward", t.carryForward, 1500);
}

// ── Mid-month rate revision splits the month ──
{
  const v = (id: string, from: string, rate: number, active = true): TermsRow => ({
    id, route_id: "r", effective_from: from, active, billing_type: "km", rate, km_per_day: 100,
    vehicle_capacity_mt: null, vehicle_number: null, cash_collection: false,
  });
  const ranges = termsRanges([v("a", "2020-01-01", 10), v("b", "2026-07-16", 12)], "2026-07-01", "2026-07-31");
  eq("revision ranges", ranges.map(r => [r.terms.id, r.from, r.to]), [["a", "2026-07-01", "2026-07-15"], ["b", "2026-07-16", "2026-07-31"]]);
  const stop = termsRanges([v("a", "2020-01-01", 10), v("x", "2026-07-21", 10, false)], "2026-07-01", "2026-07-31");
  eq("contract ended on the 20th", stop.map(r => [r.from, r.to]), [["2026-07-01", "2026-07-20"]]);
  const late = termsRanges([v("n", "2026-07-11", 10)], "2026-07-01", "2026-07-31");
  eq("route starts on the 11th", late.map(r => [r.from, r.to]), [["2026-07-11", "2026-07-31"]]);
  eq("future terms only", termsRanges([v("f", "2026-08-01", 10)], "2026-07-01", "2026-07-31").length, 0);

  const a = seg("km", 15, 100, 10, 0);
  const b = seg("km", 16, 100, 12, 0);
  eq("split gross 15×100×10 + 16×100×12", billTotals([a, b], [], "gross").gross, 34200);
}

// ── Day override ──
{
  const s = seg("km", 31, 300, 12.79, 0);
  s.daysOverride = 30;
  eq("override 30 days", billTotals([s], [], "gross").gross, 115110);
}

// ── TDS (194C) and financial year ──
eq("FY of Jul 2026", financialYear("2026-07-01"), "2026-27");
eq("FY of Mar 2027", financialYear("2027-03-01"), "2026-27");
eq("FY of Apr 2027", financialYear("2027-04-01"), "2027-28");
eq("TDS no PAN", tdsPercent({ pan: null, entityType: "individual", declarationFy: null }, "2026-27"), 20);
eq("TDS declaration this FY", tdsPercent({ pan: "ABCDE1234F", entityType: "individual", declarationFy: "2026-27" }, "2026-27"), 0);
eq("TDS declaration last FY", tdsPercent({ pan: "ABCDE1234F", entityType: "individual", declarationFy: "2025-26" }, "2026-27"), 1);
eq("TDS firm", tdsPercent({ pan: "ABCDE1234F", entityType: "other", declarationFy: null }, "2026-27"), 2);

console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
