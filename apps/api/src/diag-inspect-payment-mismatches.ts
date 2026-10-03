// Read-only: characterise the razorpay_payments-vs-order differences.
// If they are sub-paisa, they are decimal drift. If they are whole rupees,
// they are order modifications / partial payments and predate this work.
import { pgClient } from "./lib/db.js";

async function main() {
  const rows = await pgClient<any[]>`
    SELECT rp.amount::text        AS paid,
           o.grand_total::text    AS order_total,
           (rp.amount - o.grand_total)::text AS diff,
           o.status::text         AS order_status,
           rp.status::text        AS pay_status,
           o.updated_at > rp.created_at AS order_changed_after_payment
      FROM razorpay_payments rp
      JOIN orders o ON o.id = rp.order_id
     WHERE rp.kind = 'order_payment'
       AND rp.status IN ('paid', 'refunded')
       AND ROUND(rp.amount * 100) <> ROUND(o.grand_total * 100)
     ORDER BY ABS(rp.amount - o.grand_total) DESC
  `;

  console.log(`mismatched captured payments: ${rows.length}\n`);

  let subPaisa = 0;
  for (const r of rows) {
    if (Math.abs(parseFloat(r.diff)) < 0.01) subPaisa++;
  }
  console.log(`   differences under one paisa (decimal drift): ${subPaisa}`);
  console.log(`   differences of a paisa or more (real change): ${rows.length - subPaisa}\n`);

  console.log("largest 12:");
  console.log("   paid        order       diff        order_status   changed_after_pay");
  for (const r of rows.slice(0, 12)) {
    console.log(
      `   ${String(r.paid).padStart(10)}  ${String(r.order_total).padStart(10)}  ` +
      `${String(r.diff).padStart(10)}  ${String(r.order_status).padEnd(14)} ${r.order_changed_after_payment}`
    );
  }

  const byStatus = new Map<string, number>();
  for (const r of rows) byStatus.set(r.order_status, (byStatus.get(r.order_status) ?? 0) + 1);
  console.log("\nby order status:");
  for (const [s, n] of byStatus) console.log(`   ${s.padEnd(18)} ${n}`);

  const changed = rows.filter((r) => r.order_changed_after_payment).length;
  console.log(`\norders edited after the payment was taken: ${changed} / ${rows.length}`);

  await pgClient.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
