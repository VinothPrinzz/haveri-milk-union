import { pgClient } from "./lib/db.js";
import { balanceRefundedForOrder, refundableToBank } from "./lib/refund-accounting.js";
const ORDER="75b8e03f-c197-4568-ba16-b48f297f94ea";
const DEALER="eb53a60e-3c58-43cb-ab3a-a8cf3b3c087b";
const DATE="2026-08-29";
async function main(){
  const [rp]=await pgClient`
    SELECT amount::float8 AS amount, amount_refunded::float8 AS refunded, status::text
      FROM razorpay_payments WHERE order_id=${ORDER}`;
  const bal=await balanceRefundedForOrder(pgClient,ORDER);
  console.log("REFUND CEILING");
  console.log(`  paid ${rp!.amount.toFixed(2)}  gateway-refunded ${rp!.refunded.toFixed(2)}  balance-rail net ${bal.toFixed(2)}`);
  console.log(`  still refundable to bank: Rs ${refundableToBank(Math.max(0,rp!.amount-rp!.refunded),bal).toFixed(2)}`);

  console.log("\nDAY BOOK 2026-08-29, this dealer");
  const rec=await pgClient`
    SELECT amount::text, mode::text, reference FROM payments
     WHERE dealer_id=${DEALER}::uuid AND received_date=${DATE}::date
       AND reference='pay_TVb6ydtQ1iDINe'`;
  console.log("  sec 1 receipts (cash IN): ", JSON.stringify(rec));
  const ref=await pgClient`
    SELECT rf.amount::text, rf.status::text FROM razorpay_refunds rf
      JOIN razorpay_payments p ON p.id=rf.razorpay_payment_row
     WHERE p.order_id=${ORDER} AND rf.status='processed'
       AND (rf.processed_at AT TIME ZONE 'Asia/Kolkata')::date=${DATE}::date`;
  console.log("  sec 3a gateway refunds (cash OUT):", JSON.stringify(ref));

  console.log("\nAR AGING / INVOICE");
  const inv=await pgClient`
    SELECT i.invoice_number AS "no", i.total_amount::text AS total,
           i.paid_amount::text AS paid, i.payment_status::text AS status,
           i.due_date::text AS due, o.status::text AS "orderStatus"
      FROM invoices i JOIN orders o ON o.id=i.order_id
     WHERE i.order_id=${ORDER}::uuid`;
  console.log(" ",JSON.stringify(inv[0]));
  const [cancelled]=await pgClient`
    SELECT count(*)::int AS n,
           COALESCE(SUM(i.total_amount - i.paid_amount),0)::float8 AS "openValue"
      FROM invoices i JOIN orders o ON o.id=i.order_id
     WHERE o.status='cancelled' AND i.total_amount - i.paid_amount > 0.01`;
  console.log(`  invoices on CANCELLED orders still showing a balance: ${cancelled!.n} (Rs ${Number(cancelled!.openValue).toFixed(2)})`);
  await pgClient.end();
}
main().catch(async e=>{console.error(e);await pgClient.end();process.exit(1);});
