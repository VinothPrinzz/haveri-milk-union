// ═══════════════════════════════════════════════════════════════════════
// diag-price-variant-check.ts — READ ONLY.
//
// Proves the two rules the reports now follow (see the B9 header in
// routes/sales-reports.ts):
//
//   1. GST is read live and re-applied to history, gross-preserving. So the
//      statement's grand total must not move by a paisa when the breakup is
//      derived from products.gst_percent instead of the per-line snapshot.
//   2. A price revision splits into A / B rows instead of averaging. So we
//      list every SKU that sold at more than one gross rate in the period.
//
// USAGE (from apps/api):  npx tsx src/diag-price-variant-check.ts [from] [to]
// ═══════════════════════════════════════════════════════════════════════
import { pgClient } from "./lib/db.js";

const from = process.argv[2] ?? "2026-07-01";
const to   = process.argv[3] ?? "2026-08-28";

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

const combined = () => pgClient`
  WITH combined AS (
    SELECT oi.product_id, o.delivery_date AS sale_date, oi.quantity::int AS qty,
           oi.line_total::numeric AS amount,
           round(oi.unit_price * (1 + oi.gst_percent / 100), 2) AS rate,
           oi.gst_percent::numeric AS snap_gst, oi.gst_amount::numeric AS snap_tax
    FROM orders o
    JOIN dealers d ON d.id = o.dealer_id
    JOIN order_items oi ON oi.order_id = o.id
    WHERE o.delivery_date >= ${from}::date AND o.delivery_date <= ${to}::date
      AND o.created_at >= ${from}::date - interval '31 days'
      AND o.created_at <  ${to}::date + interval '2 days'
      AND o.status IN ('confirmed', 'dispatched', 'delivered')
      AND COALESCE(d.customer_type::text, '') NOT LIKE 'Credit Inst%'
    UNION ALL
    SELECT dsi.product_id, ds.sale_date, dsi.quantity::int, dsi.line_total::numeric,
           round(dsi.unit_price * (1 + dsi.gst_percent / 100), 2),
           dsi.gst_percent::numeric, dsi.gst_amount::numeric
    FROM direct_sales ds
    JOIN direct_sale_items dsi ON dsi.direct_sale_id = ds.id
    WHERE ds.sale_date >= ${from}::date AND ds.sale_date <= ${to}::date
      AND ds.status = 'confirmed'
      AND ds.customer_type::text <> 'vip_sample'
      AND ds.payment_mode::text <> 'credit'
    UNION ALL
    SELECT eoi.product_id, eo.delivery_date, eoi.quantity::int, eoi.line_total::numeric,
           round(eoi.unit_price * (1 + eoi.gst_percent / 100), 2),
           eoi.gst_percent::numeric, eoi.gst_amount::numeric
    FROM employee_orders eo
    JOIN employee_order_items eoi ON eoi.employee_order_id = eo.id
    WHERE eo.delivery_date >= ${from}::date AND eo.delivery_date <= ${to}::date
      AND eo.status IN ('confirmed', 'dispatched', 'delivered')
  )
  SELECT p.id, COALESCE(p.report_alias, p.name) AS name,
         p.gst_percent::numeric AS master_gst,
         c.rate, c.snap_gst,
         to_char(MIN(c.sale_date), 'YYYY-MM-DD') AS first_date,
         to_char(MAX(c.sale_date), 'YYYY-MM-DD') AS last_date,
         SUM(c.qty)::int AS qty,
         SUM(c.amount)::numeric AS gross,
         SUM(c.snap_tax)::numeric AS snap_tax
  FROM combined c
  JOIN products p ON p.id = c.product_id
  GROUP BY p.id, p.report_alias, p.name, p.gst_percent, c.rate, c.snap_gst
  ORDER BY p.sort_order, name, MIN(c.sale_date), c.rate
`;

const rows = (await combined()) as any[];

// ── 1. Gross is frozen; only the split moves ──
let gross = 0, snapTax = 0, liveTax = 0;
for (const r of rows) {
  const g = parseFloat(r.gross) || 0;
  gross += g;
  snapTax += parseFloat(r.snap_tax) || 0;
  const basic = round2(g / (1 + (parseFloat(r.master_gst) || 0) / 100));
  liveTax += round2(g - basic);
}
console.log(`Period ${from} .. ${to}  (cash side, the GST Statement default)`);
console.log(`  gross booked        ₹${round2(gross).toLocaleString("en-IN")}   <- unchanged by either rule`);
console.log(`  tax, line snapshots ₹${round2(snapTax).toLocaleString("en-IN")}`);
console.log(`  tax, live GST rate  ₹${round2(liveTax).toLocaleString("en-IN")}`);
console.log(`  moved into/out of tax: ₹${round2(liveTax - snapTax).toLocaleString("en-IN")}`);

// ── 2. Which SKUs a GST edit used to split, and no longer does ──
const gstSplit = new Map<string, Set<string>>();
for (const r of rows) {
  const s = gstSplit.get(r.name) ?? new Set<string>();
  s.add(String(round2(parseFloat(r.snap_gst))));
  gstSplit.set(r.name, s);
}
const gstSplits = [...gstSplit].filter(([, s]) => s.size > 1);
console.log(`\nSKUs whose LINES hold more than one GST rate (used to be extra rows, now merged):`);
if (!gstSplits.length) console.log("  none");
for (const [name, s] of gstSplits) console.log(`  ${name}: snapshots ${[...s].join("% / ")}%`);

// ── 3. Which SKUs now split A / B / C on price ──
const byProduct = new Map<string, any[]>();
for (const r of rows) {
  const list = byProduct.get(r.name) ?? [];
  const hit = list.find(x => round2(parseFloat(x.rate)) === round2(parseFloat(r.rate)));
  if (hit) {
    hit.qty += Number(r.qty) || 0;
    hit.grossSum += parseFloat(r.gross) || 0;
    if (r.first_date < hit.first_date) hit.first_date = r.first_date;
    if (r.last_date > hit.last_date) hit.last_date = r.last_date;
  } else {
    list.push({ ...r, qty: Number(r.qty) || 0, grossSum: parseFloat(r.gross) || 0 });
  }
  byProduct.set(r.name, list);
}
const revised = [...byProduct].filter(([, l]) => l.length > 1);
console.log(`\nSKUs sold at more than one PRICE in the period (now A / B / C rows):`);
if (!revised.length) console.log("  none");
for (const [name, list] of revised) {
  list.sort((a, b) => a.first_date.localeCompare(b.first_date) || a.rate - b.rate);
  list.forEach((v, i) => {
    const letter = String.fromCharCode(65 + i);
    console.log(
      `  ${name} → ${letter}  ₹${round2(parseFloat(v.rate)).toFixed(2)}  ` +
      `${v.first_date}..${v.last_date}  ${v.qty} pkts  ₹${round2(v.grossSum).toLocaleString("en-IN")}`
    );
  });
}
console.log(`\n${rows.length} (product, price, snapshot-rate) groups; ${byProduct.size} SKUs traded.`);
await pgClient.end();
