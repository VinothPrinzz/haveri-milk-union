// Read-only: run the NEW Agent Sales grouping and prove the split is gone.
import { pgClient } from "./lib/db.js";
const FROM = "2026-08-01", TO = "2026-08-21";

async function main() {
  const [d] = (await pgClient`
    SELECT id, code, name FROM dealers
     WHERE name ILIKE '%ASHWINI BHAGANNANAVAR%' AND deleted_at IS NULL`) as any[];
  if (!d) { console.log("dealer not found"); return; }
  console.log(`${d.code} ${d.name}`);

  const rows = await pgClient`
    WITH combined AS (
      SELECT o.dealer_id, oi.product_id,
             oi.unit_price::numeric AS unit_price, oi.gst_percent::numeric AS gst_percent,
             oi.quantity::int AS qty, oi.line_total::numeric AS amount
        FROM orders o JOIN order_items oi ON oi.order_id = o.id
       WHERE o.delivery_date >= ${FROM}::date AND o.delivery_date <= ${TO}::date
         AND o.created_at >= ${FROM}::date - interval '31 days'
         AND o.created_at <  ${TO}::date + interval '2 days'
         AND o.status IN ('confirmed','dispatched','delivered')
      UNION ALL
      SELECT ds.customer_id, dsi.product_id, dsi.unit_price::numeric, dsi.gst_percent::numeric,
             dsi.quantity::int, dsi.line_total::numeric
        FROM direct_sales ds JOIN direct_sale_items dsi ON dsi.direct_sale_id = ds.id
       WHERE ds.customer_type = 'agent' AND ds.sale_date >= ${FROM}::date
         AND ds.sale_date <= ${TO}::date AND ds.status = 'confirmed'
    )
    SELECT COALESCE(p.report_alias, p.name) AS product_name,
           round(cb.unit_price * (1 + cb.gst_percent / 100), 2) AS rate,
           SUM(cb.qty)::int AS qty, SUM(cb.amount)::numeric AS amount
      FROM combined cb
      JOIN dealers d ON d.id = cb.dealer_id
      JOIN products p ON p.id = cb.product_id
      JOIN categories c ON c.id = p.category_id
     WHERE d.id = ${d.id}::uuid
     GROUP BY cb.product_id, p.report_alias, p.name,
              round(cb.unit_price * (1 + cb.gst_percent / 100), 2)
     ORDER BY COALESCE(p.report_alias, p.name),
              round(cb.unit_price * (1 + cb.gst_percent / 100), 2)
  `;

  const seen = new Map<string, number>();
  for (const r of rows as any[]) seen.set(r.product_name, (seen.get(r.product_name) ?? 0) + 1);

  const WATCH = ["COOKIES 20GM","ECLAIRS 3.6 JAR","KODUBALE 30GM 10 PACK",
                 "SFM GBOTTLE 200ML 25 P","SLICECAKE FRUITY (12P)","SLICECAKE VANILA(12P)",
                 "GHEE SACHET 200ML"];
  console.log("\nthe circled SKUs, as the sheet now prints them:");
  for (const r of rows as any[]) {
    if (!WATCH.includes(r.product_name)) continue;
    console.log(`   ${String(r.product_name).padEnd(24)} rate=${parseFloat(r.rate).toFixed(2).padStart(8)}  qty=${String(r.qty).padStart(4)}  amount=${parseFloat(r.amount).toFixed(2).padStart(10)}`);
  }
  const dupes = [...seen.entries()].filter(([, n]) => n > 1);
  console.log(`\nproducts still printing more than one line: ${dupes.length}`);
  for (const [name, n] of dupes) {
    console.log(`   ${name} (${n}) — rates: ${(rows as any[]).filter(r => r.product_name === name).map(r => parseFloat(r.rate).toFixed(2)).join(" / ")}`);
  }
  console.log(`\ntotal lines on the sheet: ${(rows as any[]).length}`);
  const total = (rows as any[]).reduce((s, r) => s + parseFloat(r.amount), 0);
  console.log(`sheet total: ${total.toFixed(2)}`);
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
