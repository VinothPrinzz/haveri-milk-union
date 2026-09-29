// Read-only: does the GST Statement's invoice value equal money collected,
// and is the A/B/C price-variant split unchanged by the residue allocation?
// Mirrors the cash-side query in sales-reports.ts (orders rail; the counter
// and subsidy rails are tiny and follow the same shape).
import { pgClient } from "./lib/db.js";
const n=(x:any)=>Number(x??0);
const FROM="2026-08-01", TO="2026-08-31";

async function main(){
  // NEW: gross carries the document residue on the largest line
  const rowsNew = await pgClient`
    WITH ord AS (
      SELECT o.id, o.delivery_date, o.grand_total
        FROM orders o JOIN dealers d ON d.id = o.dealer_id
       WHERE o.delivery_date BETWEEN ${FROM}::date AND ${TO}::date
         AND o.created_at >= ${FROM}::date - interval '31 days'
         AND o.created_at <  ${TO}::date + interval '2 days'
         AND o.status IN ('confirmed','dispatched','delivered')
         AND NOT (COALESCE(d.customer_type::text,'') LIKE 'Credit Inst%' AND o.payment_mode::text <> 'upi')
    ),
    li AS (
      SELECT oi.order_id, oi.product_id, oi.quantity, oi.line_total, oi.unit_price, oi.gst_percent,
             SUM(oi.line_total) OVER (PARTITION BY oi.order_id) AS line_sum,
             ROW_NUMBER() OVER (PARTITION BY oi.order_id ORDER BY oi.line_total DESC, oi.product_id) AS rn
        FROM order_items oi JOIN ord ON ord.id = oi.order_id
    )
    SELECT li.product_id, round(li.unit_price*(1+li.gst_percent/100),2) AS gross_rate,
           SUM(li.quantity)::int qty,
           SUM(li.line_total + CASE WHEN li.rn=1 THEN ord.grand_total - li.line_sum ELSE 0 END)::float8 amount
      FROM li JOIN ord ON ord.id = li.order_id
     GROUP BY 1,2`;

  // OLD: plain line totals
  const rowsOld = await pgClient`
    SELECT oi.product_id, round(oi.unit_price*(1+oi.gst_percent/100),2) AS gross_rate,
           SUM(oi.quantity)::int qty, SUM(oi.line_total)::float8 amount
      FROM orders o JOIN dealers d ON d.id=o.dealer_id JOIN order_items oi ON oi.order_id=o.id
     WHERE o.delivery_date BETWEEN ${FROM}::date AND ${TO}::date
       AND o.created_at >= ${FROM}::date - interval '31 days'
       AND o.created_at <  ${TO}::date + interval '2 days'
       AND o.status IN ('confirmed','dispatched','delivered')
       AND NOT (COALESCE(d.customer_type::text,'') LIKE 'Credit Inst%' AND o.payment_mode::text <> 'upi')
     GROUP BY 1,2`;

  const [g] = await pgClient`
    SELECT COALESCE(SUM(o.grand_total),0)::float8 v, count(*)::int c
      FROM orders o JOIN dealers d ON d.id=o.dealer_id
     WHERE o.delivery_date BETWEEN ${FROM}::date AND ${TO}::date
       AND o.created_at >= ${FROM}::date - interval '31 days'
       AND o.created_at <  ${TO}::date + interval '2 days'
       AND o.status IN ('confirmed','dispatched','delivered')
       AND NOT (COALESCE(d.customer_type::text,'') LIKE 'Credit Inst%' AND o.payment_mode::text <> 'upi')`;

  const sum = (rs:any[]) => Math.round(rs.reduce((a,r)=>a+n(r.amount),0)*100)/100;
  const newTot = sum(rowsNew as any[]), oldTot = sum(rowsOld as any[]);
  const collected = Math.round(n((g as any).v)*100)/100;

  console.log(`\nGST Statement, orders rail, ${FROM} .. ${TO}\n`);
  console.log(`  OLD invoice value (line totals)   ${oldTot.toFixed(2).padStart(14)}`);
  console.log(`  NEW invoice value (collected)     ${newTot.toFixed(2).padStart(14)}`);
  console.log(`  money actually charged            ${collected.toFixed(2).padStart(14)}   (${(g as any).c} orders)`);
  console.log(`  NEW == collected                  ${Math.abs(newTot-collected)<0.005 ? "yes" : `NO (off ${(newTot-collected).toFixed(2)})`}`);
  console.log(`\n  price-variant rows OLD / NEW      ${(rowsOld as any[]).length} / ${(rowsNew as any[]).length}   ${(rowsOld as any[]).length===(rowsNew as any[]).length ? "(split unchanged)" : "<-- SPLIT CHANGED"}`);
  const keys = (rs:any[]) => new Set(rs.map(r=>`${r.product_id}|${n(r.gross_rate).toFixed(2)}`));
  const ko = keys(rowsOld as any[]), kn = keys(rowsNew as any[]);
  const same = ko.size===kn.size && [...ko].every(k=>kn.has(k));
  console.log(`  same (product, price) buckets     ${same ? "yes" : "NO"}`);
  const qo = (rowsOld as any[]).reduce((a,r)=>a+n(r.qty),0), qn = (rowsNew as any[]).reduce((a,r)=>a+n(r.qty),0);
  console.log(`  packets unchanged                 ${qo===qn ? `yes (${qn})` : `NO (${qo} vs ${qn})`}\n`);
  await pgClient.end();
}
main().catch(async e=>{console.error(e);await pgClient.end();process.exit(1);});
