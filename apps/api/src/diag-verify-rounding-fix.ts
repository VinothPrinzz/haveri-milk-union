// Read-only: prove the new line-first rounding makes documents foot, by
// replaying real order lines through it. History is NOT touched.
import { pgClient } from "./lib/db.js";
import { calcLine, sumLines, round2, type LineTotals } from "./lib/line-totals.js";
const n=(x:any)=>Number(x??0);

async function main(){
  console.log("── replay August's worst-drifting orders under the NEW rule ──");
  const orders = await pgClient`
    SELECT o.id::text id, o.grand_total::float8 gt, li.s::float8 lines, o.delivery_date::text dd
      FROM orders o JOIN LATERAL (SELECT COALESCE(SUM(oi.line_total),0)::numeric s FROM order_items oi WHERE oi.order_id=o.id) li ON true
     WHERE o.status IN ('confirmed','dispatched','delivered') AND o.created_at < '2026-09-03'
       AND COALESCE(o.delivery_date,(o.created_at AT TIME ZONE 'Asia/Kolkata')::date) BETWEEN '2026-08-01' AND '2026-08-31'
       AND ABS(o.grand_total-li.s) > 0.004
     ORDER BY ABS(o.grand_total-li.s) DESC LIMIT 8`;
  let fail=0;
  for(const o of orders as any[]){
    const items = await pgClient`SELECT quantity::float8 q, unit_price::float8 up, gst_percent::float8 g
        FROM order_items WHERE order_id=${o.id}::uuid`;
    const lines: LineTotals[] = (items as any[]).map(i => calcLine(n(i.up), n(i.g), n(i.q)));
    const t = sumLines(lines);
    const sumOfPrinted = round2(lines.reduce((a,l)=>a+l.total,0));
    const foots = Math.abs(sumOfPrinted - t.grandTotal) < 0.0001
               && Math.abs(round2(t.subtotal+t.totalGst) - t.grandTotal) < 0.0001;
    if(!foots) fail++;
    console.log(`  ${o.id.slice(0,8)} ${o.dd}  OLD: total ${n(o.gt).toFixed(2)} vs printed lines ${n(o.lines).toFixed(2)} (off ${(n(o.gt)-n(o.lines)).toFixed(2)})`);
    console.log(`             NEW: total ${t.grandTotal.toFixed(2)} == Σ printed lines ${sumOfPrinted.toFixed(2)} == subtotal ${t.subtotal.toFixed(2)} + gst ${t.totalGst.toFixed(2)}  ${foots?'FOOTS':'*** STILL BROKEN ***'}`);
  }
  console.log(`\n  ${(orders as any[]).length - fail}/${(orders as any[]).length} foot exactly under the new rule`);

  console.log("\n── replay EVERY August order under the new rule ──");
  const all = await pgClient`
    SELECT o.id::text id FROM orders o
     WHERE o.status IN ('confirmed','dispatched','delivered') AND o.created_at < '2026-09-03'
       AND COALESCE(o.delivery_date,(o.created_at AT TIME ZONE 'Asia/Kolkata')::date) BETWEEN '2026-08-01' AND '2026-08-31'`;
  const ids = (all as any[]).map(r=>r.id);
  const rows = await pgClient`
    SELECT order_id::text oid, quantity::float8 q, unit_price::float8 up, gst_percent::float8 g
      FROM order_items WHERE order_id = ANY(${ids}::uuid[])`;
  const byOrder = new Map<string, LineTotals[]>();
  for(const r of rows as any[]){
    const l = byOrder.get(r.oid) ?? [];
    l.push(calcLine(n(r.up), n(r.g), n(r.q)));
    byOrder.set(r.oid, l);
  }
  let bad=0;
  for(const [,lines] of byOrder){
    const t = sumLines(lines);
    const printed = round2(lines.reduce((a,l)=>a+l.total,0));
    if(Math.abs(printed-t.grandTotal) > 0.0001 || Math.abs(round2(t.subtotal+t.totalGst)-t.grandTotal) > 0.0001) bad++;
  }
  console.log(`  ${byOrder.size} orders replayed, ${bad} that do not foot`);
  await pgClient.end();
}
main().catch(async e=>{console.error(e);await pgClient.end();process.exit(1);});
