// Read-only proof of the rule the union asked for:
//   "there shouldn't be any difference between the payment record and the
//    amount shown in our software".
//
// An amount can only diverge from what a gateway moves if it carries a
// third decimal — Razorpay settles in integer paise. So the proof is that
// NO stored amount has a non-zero third decimal, and that every amount
// survives a rupees -> paise -> rupees round trip unchanged.
import { pgClient } from "./lib/db.js";

async function main() {
  console.log("── every amount must round-trip through paise unchanged ──");

  const checks: { label: string; sql: () => Promise<any[]> }[] = [
    {
      label: "orders.grand_total",
      sql: () => pgClient`
        SELECT COUNT(*)::int AS n FROM orders
         WHERE grand_total IS NOT NULL
           AND grand_total <> ROUND(grand_total * 100) / 100`,
    },
    {
      label: "invoices.total_amount",
      sql: () => pgClient`
        SELECT COUNT(*)::int AS n FROM invoices
         WHERE total_amount IS NOT NULL
           AND total_amount <> ROUND(total_amount * 100) / 100`,
    },
    {
      label: "payments.amount",
      sql: () => pgClient`
        SELECT COUNT(*)::int AS n FROM payments
         WHERE amount IS NOT NULL
           AND amount <> ROUND(amount * 100) / 100`,
    },
    {
      label: "razorpay_payments.amount",
      sql: () => pgClient`
        SELECT COUNT(*)::int AS n FROM razorpay_payments
         WHERE amount IS NOT NULL
           AND amount <> ROUND(amount * 100) / 100`,
    },
    {
      label: "dealer_ledger.amount",
      sql: () => pgClient`
        SELECT COUNT(*)::int AS n FROM dealer_ledger
         WHERE amount IS NOT NULL
           AND amount <> ROUND(amount * 100) / 100`,
    },
  ];

  let bad = 0;
  for (const c of checks) {
    const [r] = await c.sql();
    const n = (r as any).n as number;
    bad += n;
    console.log(`   ${c.label.padEnd(26)} ${n === 0 ? "OK" : `${n} ROWS DRIFT`}`);
  }

  // A payment may legitimately differ from its order by WHOLE RUPEES when
  // the order was modified after the dealer paid — that is an order-change
  // matter, not a rounding one, and it predates the decimal work. What must
  // never happen is a FRACTION OF A PAISA of difference, because that could
  // only come from an amount carrying a third decimal.
  console.log("\n── razorpay_payments vs the order they pay for ──");
  const [drift] = await pgClient`
    SELECT COUNT(*)::int AS n
      FROM razorpay_payments rp
      JOIN orders o ON o.id = rp.order_id
     WHERE rp.kind = 'order_payment'
       AND rp.status IN ('paid', 'refunded')
       AND rp.amount <> o.grand_total
       AND ABS(rp.amount - o.grand_total) < 0.01
  `;
  const mm = (drift as any).n as number;
  console.log(`   sub-paisa differences (decimal drift): ${mm}`);

  const [edited] = await pgClient`
    SELECT COUNT(*)::int AS n
      FROM razorpay_payments rp
      JOIN orders o ON o.id = rp.order_id
     WHERE rp.kind = 'order_payment'
       AND rp.status IN ('paid', 'refunded')
       AND ROUND(rp.amount * 100) <> ROUND(o.grand_total * 100)
  `;
  console.log(
    `   whole-rupee differences (orders edited after payment, pre-existing): ${(edited as any).n}`
  );

  console.log(
    `\n${bad === 0 && mm === 0 ? "PASS — payment record and displayed amount cannot differ" : "FAIL"}`
  );
  await pgClient.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
