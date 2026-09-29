// Read-only: how much dealer money is hidden behind soft-deletes, and does a
// deleted dealer's trading still show up in the sales reports?
import { pgClient } from "./lib/db.js";
const n=(x:any)=>Number(x??0);
async function main(){
  console.log("── R G NIMBAKKANAVAR: what actually happened ──");
  const [d] = await pgClient`SELECT id, name, code, username, phone,
      (created_at AT TIME ZONE 'Asia/Kolkata')::text created,
      (deleted_at AT TIME ZONE 'Asia/Kolkata')::text deleted
      FROM dealers WHERE name ILIKE '%NIMBAKKANAVAR%' AND deleted_at IS NOT NULL LIMIT 1`;
  console.log("  ", JSON.stringify(d));
  for(const l of await pgClient`SELECT type::text, amount::float8 a, voucher_type, voucher_date::text vd,
      (created_at AT TIME ZONE 'Asia/Kolkata')::text posted, description
      FROM dealer_ledger WHERE dealer_id=${(d as any).id} ORDER BY created_at` as any[])
    console.log("   ledger", JSON.stringify(l));

  console.log("\n── ALL soft-deleted dealers holding money (ledger balance <> 0) ──");
  const rows = await pgClient`
    SELECT d.name, d.code, (d.deleted_at AT TIME ZONE 'Asia/Kolkata')::date::text del,
      (COALESCE(d.opening_balance,0)+COALESCE((SELECT SUM(CASE WHEN dl.type='credit' THEN dl.amount ELSE -dl.amount END)
          FROM dealer_ledger dl WHERE dl.dealer_id=d.id AND COALESCE(dl.voucher_type,'')<>'Opening'),0))::float8 bal,
      (SELECT COALESCE(SUM(o.grand_total),0) FROM orders o WHERE o.dealer_id=d.id
         AND o.status IN ('confirmed','dispatched','delivered') AND o.created_at > d.deleted_at)::float8 sales_after_delete
      FROM dealers d WHERE d.deleted_at IS NOT NULL`;
  const held = (rows as any[]).filter(r=>Math.abs(n(r.bal))>0.004);
  console.log(`  ${(rows as any[]).length} soft-deleted dealers; ${held.length} with a non-zero balance`);
  let pos=0, neg=0;
  for(const r of held.sort((a,b)=>Math.abs(n(b.bal))-Math.abs(n(a.bal)))){
    if(n(r.bal)>0) pos+=n(r.bal); else neg+=n(r.bal);
    console.log(`   ${String(r.code??'(no code)').padEnd(10)} ${String(r.name).slice(0,30).padEnd(30)} deleted ${r.del}  balance ${n(r.bal).toFixed(2).padStart(10)}`);
  }
  console.log(`  money owed TO deleted dealers (credit balances): ${pos.toFixed(2)}`);
  console.log(`  money owed BY deleted dealers (debit balances) : ${neg.toFixed(2)}`);

  console.log("\n── do deleted dealers' sales still reach the sales reports? ──");
  const s = await pgClient`
    SELECT count(*)::int c, COALESCE(SUM(li.s),0)::float8 v
      FROM orders o JOIN dealers d ON d.id=o.dealer_id
      JOIN LATERAL (SELECT COALESCE(SUM(oi.line_total),0)::numeric s FROM order_items oi WHERE oi.order_id=o.id) li ON true
     WHERE d.deleted_at IS NOT NULL AND o.status IN ('confirmed','dispatched','delivered')
       AND COALESCE(o.delivery_date,(o.created_at AT TIME ZONE 'Asia/Kolkata')::date) BETWEEN '2026-08-01' AND '2026-08-31'`;
  console.log(`  August Cash Sales from soft-deleted dealers: ${n((s as any)[0].v).toFixed(2)} over ${(s as any)[0].c} orders`);
  await pgClient.end();
}
main().catch(async e=>{console.error(e);await pgClient.end();process.exit(1);});
