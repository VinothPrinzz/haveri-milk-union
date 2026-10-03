// Read-only: the Refunds page tile "Unlinked (must be 0)" counts processed or
// pending refunds with no dealer_ledger row. Is that a real exposure?
import { pgClient } from "./lib/db.js";
const n=(x:any)=>Number(x??0);
async function main(){
  const [s] = await pgClient`
    SELECT count(*)::int total,
           count(*) FILTER (WHERE status IN ('processed','pending') AND ledger_entry_id IS NULL)::int unlinked,
           COALESCE(SUM(amount) FILTER (WHERE status IN ('processed','pending') AND ledger_entry_id IS NULL),0)::float8 unlinked_amt
      FROM razorpay_refunds`;
  console.log(`refunds: ${(s as any).total} total, ${(s as any).unlinked} unlinked, Rs ${n((s as any).unlinked_amt).toFixed(2)}\n`);

  // For each refund, what rail was the order on? A pay-now UPI order never
  // touched dealer_ledger (payment and charge both bypass it), so a bank
  // refund needs no ledger row either. A wallet/credit order DID debit the
  // ledger, so a refund without a credit back would overstate the balance.
  const rows = await pgClient`
    SELECT rf.razorpay_refund_id, rf.amount::float8 amt, rf.status::text,
           rf.ledger_entry_id IS NOT NULL AS linked,
           d.code, o.payment_mode::text pm, o.status::text ostatus,
           (COALESCE(rf.processed_at,rf.created_at) AT TIME ZONE 'Asia/Kolkata')::date::text dt
      FROM razorpay_refunds rf
      LEFT JOIN dealers d ON d.id = rf.dealer_id
      LEFT JOIN LATERAL (SELECT x.order_id FROM razorpay_payments x
                          WHERE x.razorpay_payment_id = rf.razorpay_payment_id LIMIT 1) rp ON true
      LEFT JOIN LATERAL (SELECT o2.payment_mode, o2.status FROM orders o2 WHERE o2.id = rp.order_id LIMIT 1) o ON true
     ORDER BY rf.created_at`;
  console.log("date        refund        amt  linked  dealer   order mode / status");
  for(const r of rows as any[])
    console.log(`${r.dt}  ${String(r.razorpay_refund_id).slice(0,18).padEnd(18)} ${n(r.amt).toFixed(2).padStart(9)}  ${r.linked?"yes ":"NO  "}  ${String(r.code??"-").padEnd(7)} ${String(r.pm??"?")} / ${String(r.ostatus??"?")}`);

  // The real test: does the dealer's ledger balance already account for it?
  console.log("\nA pay-now UPI order never wrote a ledger row, so its bank refund needs none.");
  const [w] = await pgClient`
    SELECT count(*)::int c, COALESCE(SUM(rf.amount),0)::float8 v
      FROM razorpay_refunds rf
      LEFT JOIN LATERAL (SELECT x.order_id FROM razorpay_payments x
                          WHERE x.razorpay_payment_id = rf.razorpay_payment_id LIMIT 1) rp ON true
      LEFT JOIN LATERAL (SELECT o2.payment_mode::text pm FROM orders o2 WHERE o2.id = rp.order_id LIMIT 1) o ON true
     WHERE rf.status IN ('processed','pending') AND rf.ledger_entry_id IS NULL
       AND COALESCE(o.pm,'upi') <> 'upi'`;
  console.log(`Unlinked refunds on a NON pay-now order (would be real exposure): ${(w as any).c}, Rs ${n((w as any).v).toFixed(2)}`);
  await pgClient.end();
}
main().catch(async e=>{console.error(e);await pgClient.end();process.exit(1);});
