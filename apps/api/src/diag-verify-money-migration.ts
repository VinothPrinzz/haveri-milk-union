// Read-only: assert the money model the union actually runs on.
//
//   RATE   (cost per unit)      → numeric(_,3)
//   AMOUNT (what changes hands) → numeric(_,2)
//
// Run after migrations 0069 + 0070. Any column on the wrong side is a bug:
// a 3dp amount can be charged at a different figure than it is recorded at,
// which is exactly what 0070 exists to prevent.
import { pgClient } from "./lib/db.js";

/** Columns that are genuinely rates and must carry three decimals. */
const RATE_COLUMNS = new Set([
  "products.base_price",
  "products.dealer_price",
  "products.mrp",
  "products.retail_dealer_price",
  "products.credit_inst_mrp_price",
  "products.credit_inst_dealer_price",
  "products.parlour_dealer_price",
  "price_revisions.old_price",
  "price_revisions.new_price",
  "price_chart.price",
  "employee_subsidy_rules.subsidy_price",
  "order_items.unit_price",
  "direct_sale_items.unit_price",
  "employee_order_items.unit_price",
  "employee_order_items.mrp_reference",
  "stock_receipts.unit_cost",
  "supplier_product_costs.unit_cost",
  "routes.rate_per_trip",
  "contractors.rate_per_km",
]);

/**
 * Not money at all — percentages, pack weight, distances. Verified against
 * the live schema: these are the ONLY non-money numeric columns, so anything
 * else reaching the checks below is genuinely a rate or an amount.
 */
const NOT_MONEY = new Set([
  "gst_percent", "subsidy_percent", "old_gst_percent", "new_gst_percent",
  "pack_size", "total_km_per_day", "distance_km",
]);

async function main() {
  const cols = await pgClient<
    { table_name: string; column_name: string; scale: number }[]
  >`
    SELECT c.table_name, c.column_name, c.numeric_scale::int AS scale
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
       AND c.data_type = 'numeric'
       AND c.table_name NOT LIKE 'orders_%'   -- partitions mirror the parent
     ORDER BY c.table_name, c.column_name
  `;

  const wrong: string[] = [];
  let rates = 0;
  let amounts = 0;

  for (const c of cols) {
    if (NOT_MONEY.has(c.column_name)) continue;
    const key = `${c.table_name}.${c.column_name}`;
    const shouldBe3 = RATE_COLUMNS.has(key);
    if (shouldBe3) {
      rates++;
      if (c.scale !== 3) wrong.push(`${key} is a RATE but has scale ${c.scale} (want 3)`);
    } else {
      amounts++;
      if (c.scale !== 2) wrong.push(`${key} is an AMOUNT but has scale ${c.scale} (want 2)`);
    }
  }

  // Every declared rate column must actually exist.
  const live = new Set(cols.map((c) => `${c.table_name}.${c.column_name}`));
  for (const r of RATE_COLUMNS) if (!live.has(r)) wrong.push(`${r} declared as a rate but does not exist`);

  console.log(`rate columns   (want scale 3): ${rates}`);
  console.log(`amount columns (want scale 2): ${amounts}`);
  console.log(`\nviolations: ${wrong.length}`);
  wrong.forEach((w) => console.log("   " + w));
  console.log(`\n${wrong.length === 0 ? "PASS — rates 3dp, amounts 2dp" : "FAIL"}`);

  await pgClient.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
