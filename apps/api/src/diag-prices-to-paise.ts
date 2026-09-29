// ═══════════════════════════════════════════════════════════════════════
// Prices → paise. Every price master column drops its third decimal.
//
// base_price is RE-DERIVED from the gross dealer_price, never rounded from
// its own stored value: 267.86 / 1.05 = 255.104762, whose 2dp form is
// 255.10. Rounding the stored 255.105 instead would give 255.11 and quietly
// raise the rate above the chart.
//
// A base_price that is NOT the derived figure (a hand-set price) is left
// alone and reported — re-deriving it would reprice the product.
//
// DRY RUN by default. APPLY=1 to write.
// ═══════════════════════════════════════════════════════════════════════
import { pgClient } from "./lib/db.js";

const APPLY = process.env.APPLY === "1";

async function main() {
  console.log(APPLY ? "*** APPLY ***" : "--- dry run ---");

  // ── 1. products.base_price ──────────────────────────────────────────
  const base = await pgClient`
    SELECT id, code, name, gst_percent::numeric AS gst,
           base_price::numeric   AS base,
           dealer_price::numeric AS dealer,
           round(dealer_price::numeric / (1 + gst_percent::numeric / 100), 2) AS want
      FROM products
     WHERE deleted_at IS NULL AND dealer_price IS NOT NULL AND dealer_price > 0
     ORDER BY code
  `;
  const derived: any[] = [], handSet: any[] = [];
  for (const r of base as any[]) {
    const exact = parseFloat(r.dealer) / (1 + parseFloat(r.gst) / 100);
    const cur = parseFloat(r.base), want = parseFloat(r.want);
    if (Math.abs(cur - exact) > 0.005) { handSet.push({ ...r, exact }); continue; }
    if (cur !== want) derived.push({ ...r, want });
  }
  console.log(`\nbase_price: ${derived.length} to re-derive at 2dp, ${handSet.length} hand-set (left alone), ${(base as any[]).length} total`);
  for (const r of derived.slice(0, 200)) {
    console.log(`   ${String(r.code).padEnd(7)} ${String(r.name).slice(0,28).padEnd(28)} gross=${r.dealer} gst=${r.gst}  ${r.base} → ${r.want}`);
  }
  if (handSet.length) {
    console.log("  hand-set base prices (NOT touched):");
    for (const r of handSet.slice(0, 40))
      console.log(`   ${String(r.code).padEnd(7)} ${String(r.name).slice(0,28).padEnd(28)} base=${r.base} but gross/gst implies ${r.exact.toFixed(4)}`);
  }

  // ── 2. the other price columns: plain round to paise ────────────────
  const cols = ["dealer_price","mrp","retail_dealer_price","credit_inst_mrp_price",
                "credit_inst_dealer_price","parlour_dealer_price"];
  for (const c of cols) {
    const [row] = (await pgClient`
      SELECT count(*)::int AS n FROM products
       WHERE deleted_at IS NULL AND ${pgClient(c)} IS NOT NULL
         AND ${pgClient(c)} <> round(${pgClient(c)}::numeric, 2)`) as any[];
    console.log(`products.${c}: ${row?.n ?? 0} rows with a third decimal`);
  }

  const [subsidyNRow] = (await pgClient`
    SELECT count(*)::int AS n FROM employee_subsidy_rules
     WHERE subsidy_price <> round(subsidy_price::numeric, 2)`) as any[];
  console.log(`employee_subsidy_rules.subsidy_price: ${subsidyNRow?.n ?? 0} rows with a third decimal`);

  const [chartNRow] = (await pgClient`
    SELECT count(*)::int AS n FROM price_chart
     WHERE price <> round(price::numeric, 2)`) as any[];
  console.log(`price_chart.price: ${chartNRow?.n ?? 0} rows with a third decimal`);

  const [revNRow] = (await pgClient`
    SELECT count(*)::int AS n FROM price_revisions
     WHERE old_price <> round(old_price::numeric, 2) OR new_price <> round(new_price::numeric, 2)`) as any[];
  console.log(`price_revisions: ${revNRow?.n ?? 0} rows with a third decimal`);

  if (!APPLY) { console.log("\n(dry run — nothing written)"); return; }

  await pgClient.begin(async (tx) => {
    // Gross columns first, so base_price is derived from the SETTLED gross
    // (P10's dealer_price is 32.143 → 32.14 before anything divides by it).
    for (const c of cols) {
      await tx`UPDATE products SET ${tx(c)} = round(${tx(c)}::numeric, 2)
                WHERE deleted_at IS NULL AND ${tx(c)} IS NOT NULL
                  AND ${tx(c)} <> round(${tx(c)}::numeric, 2)`;
    }
    // One row at a time: a bound JS array crashes Bind on the pooler.
    for (const r of derived) {
      await tx`
        UPDATE products
           SET base_price = round(dealer_price::numeric / (1 + gst_percent::numeric / 100), 2),
               updated_at = now()
         WHERE id = ${r.id}::uuid`;
    }
    await tx`UPDATE employee_subsidy_rules SET subsidy_price = round(subsidy_price::numeric, 2)
              WHERE subsidy_price <> round(subsidy_price::numeric, 2)`;
    await tx`UPDATE price_chart SET price = round(price::numeric, 2)
              WHERE price <> round(price::numeric, 2)`;
  });
  console.log(`\napplied: ${derived.length} base prices re-derived, other price columns rounded to paise.`);
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
