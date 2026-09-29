import { pgClient } from "./lib/db.js";
const n=(x:any)=>Number(x??0);
async function main(){
  console.log("── (a) is the razorpay-vs-grand_total drift real, or a join artefact? ──");
  const [dup] = await pgClient`
    SELECT count(*)::int orders_with_multi_paid FROM (
      SELECT order_id FROM razorpay_payments WHERE status='paid' AND order_id IS NOT NULL
       GROUP BY 1 HAVING count(*)>1) x`;
  console.log("  orders with >1 'paid' razorpay row:", (dup as any).orders_with_multi_paid);
  // Expected: a modify-down rewrites orders.grand_total in place while the
  // gateway keeps the ORIGINAL charge, so charged > billed is normal. What
  // matters is whether the excess came back (ledger credit or gateway refund).
  const rows = await pgClient`
    SELECT o.id::text, o.grand_total::float8 gt, rp.amount::float8 amt,
           (rp.amount-o.grand_total)::float8 diff, o.status::text, o.delivery_date::text dd,
           COALESCE((SELECT SUM(dl.amount) FROM dealer_ledger dl
                      WHERE dl.reference_id=o.id AND dl.type='credit'),0)::float8 ledger_credit,
           COALESCE((SELECT SUM(rf.amount) FROM razorpay_refunds rf
                       JOIN razorpay_payments xp ON xp.razorpay_payment_id=rf.razorpay_payment_id
                      WHERE xp.order_id=o.id AND rf.status='processed'),0)::float8 refunded
      FROM orders o
      JOIN LATERAL (SELECT x.amount FROM razorpay_payments x
                     WHERE x.order_id=o.id AND x.status='paid' ORDER BY x.created_at DESC LIMIT 1) rp ON true
     WHERE o.status IN ('confirmed','dispatched','delivered')
       AND COALESCE(o.delivery_date,(o.created_at AT TIME ZONE 'Asia/Kolkata')::date) BETWEEN '2026-08-01' AND '2026-08-31'
       AND ABS(rp.amount-o.grand_total) > 0.005`;
  const R = rows as any[];
  console.log(`  orders where latest paid charge <> grand_total: ${R.length}`);
  console.log(`  signed Σ(charged - billed) = ${R.reduce((a,r)=>a+n(r.diff),0).toFixed(2)}`);
  const stuck = R.filter(r => Math.abs((n(r.ledger_credit)+n(r.refunded)) - n(r.diff)) > 0.02);
  for(const r of stuck.slice(0,10))
    console.log(`    NOT RETURNED ${r.id.slice(0,8)} ${r.dd} billed ${n(r.gt).toFixed(2)} charged ${n(r.amt).toFixed(2)} back ${(n(r.ledger_credit)+n(r.refunded)).toFixed(2)}`);
  console.log(`  of those, excess NOT returned to the dealer: ${stuck.length} order(s), ${stuck.reduce((a,r)=>a+n(r.diff)-n(r.ledger_credit)-n(r.refunded),0).toFixed(2)}`);

  console.log("\n── (b) invoice internal consistency (Aug) ──");
  const [i1] = await pgClient`
    SELECT count(*)::int c, COALESCE(SUM(ABS(i.total_amount-(i.taxable_amount+i.total_tax))),0)::float8 d
      FROM invoices i WHERE (i.invoice_date AT TIME ZONE 'Asia/Kolkata')::date BETWEEN '2026-08-01' AND '2026-08-31'
        AND ABS(i.total_amount-(i.taxable_amount+i.total_tax)) > 0.004`;
  console.log(`  invoices where total <> taxable+tax : ${(i1 as any).c}  (Σ|gap| ${n((i1 as any).d).toFixed(2)})`);
  const [i2] = await pgClient`
    SELECT count(*)::int c, COALESCE(SUM(i.total_amount-li.s),0)::float8 net, COALESCE(SUM(ABS(i.total_amount-li.s)),0)::float8 abs
      FROM invoices i JOIN orders o ON o.id=i.order_id
      JOIN LATERAL (SELECT COALESCE(SUM(oi.line_total),0)::numeric s FROM order_items oi WHERE oi.order_id=o.id) li ON true
     WHERE (i.invoice_date AT TIME ZONE 'Asia/Kolkata')::date BETWEEN '2026-08-01' AND '2026-08-31'
       AND ABS(i.total_amount-li.s) > 0.004`;
  console.log(`  invoices whose TOTAL <> Σ its own printed lines: ${(i2 as any).c}  net ${n((i2 as any).net).toFixed(2)}  gross ${n((i2 as any).abs).toFixed(2)}`);

  console.log("\n── (c) line_total vs grand_total, whole history ──");
  for(const m of ["2026-07","2026-08","2026-09"]){
    const [r] = await pgClient`
      SELECT count(*)::int c, COALESCE(SUM(o.grand_total-li.s),0)::float8 net, COALESCE(SUM(ABS(o.grand_total-li.s)),0)::float8 abs
        FROM orders o JOIN LATERAL (SELECT COALESCE(SUM(oi.line_total),0)::numeric s FROM order_items oi WHERE oi.order_id=o.id) li ON true
       WHERE o.status IN ('confirmed','dispatched','delivered')
         AND to_char(COALESCE(o.delivery_date,(o.created_at AT TIME ZONE 'Asia/Kolkata')::date),'YYYY-MM')=${m}
         AND ABS(o.grand_total-li.s) > 0.004`;
    console.log(`  ${m}: ${String((r as any).c).padStart(5)} orders affected, net ${n((r as any).net).toFixed(2).padStart(8)}, gross ${n((r as any).abs).toFixed(2).padStart(8)}`);
  }
  console.log("\n── (d) how many products still carry a 3-decimal price? ──");
  const [p] = await pgClient`
    SELECT count(*)::int total, count(*) FILTER (WHERE base_price <> round(base_price,2))::int three_dp FROM products`;
  console.log("  ", JSON.stringify(p));
  await pgClient.end();
}
main().catch(async e=>{console.error(e);await pgClient.end();process.exit(1);});
