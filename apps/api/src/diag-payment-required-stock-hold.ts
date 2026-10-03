// ═══════════════════════════════════════════════════════════════════════
// diag-payment-required-stock-hold.ts — READ ONLY.
//
// Which "awaiting payment" indents actually hold FGS stock, and how much.
//
// The two rails behave differently, which is the whole point of this script:
//   • orders (dealers)      — fgs_available counts `stock_deducted = true`,
//                             and a payment_required order never latched it,
//                             so it holds NOTHING.
//   • employee_orders       — fgs_available counts `status NOT IN
//                             ('draft','cancelled')`, and payment_required is
//                             neither, so it DOES hold stock while it waits
//                             for finance to release it.
//
// USAGE (from apps/api):  npx tsx src/diag-payment-required-stock-hold.ts
// ═══════════════════════════════════════════════════════════════════════
import { pgClient } from "./lib/db.js";

async function main() {
  const dealerSide = await pgClient`
    SELECT o.id::text, o.delivery_date::text AS "deliveryDate",
           o.payment_mode::text AS "paymentMode",
           o.stock_deducted AS "stockDeducted",
           o.grand_total::numeric AS "grandTotal",
           d.name AS dealer
      FROM orders o
      JOIN dealers d ON d.id = o.dealer_id
     WHERE o.status = 'payment_required'
     ORDER BY o.delivery_date DESC
  `;
  console.log(`orders (dealers) in payment_required: ${dealerSide.length}`);
  for (const o of dealerSide as any[]) {
    console.log(`  ${o.deliveryDate}  ${o.paymentMode.padEnd(8)}  Rs ${o.grandTotal}  ` +
                `stock_deducted=${o.stockDeducted}  ${o.dealer}`);
  }
  const heldDealer = (dealerSide as any[]).filter(o => o.stockDeducted);
  const today = new Date(Date.now() + (5 * 60 + 30) * 60 * 1000).toISOString().slice(0, 10);
  const live = heldDealer.filter(o => o.deliveryDate >= today);
  console.log(`  -> with stock_deducted latched: ${heldDealer.length}`);
  console.log(`  -> of those, delivery date >= today (${today}), i.e. still holding sellable stock: ${live.length}`);

  const empSide = await pgClient`
    SELECT eo.id::text, eo.delivery_date::text AS "deliveryDate",
           eo.grand_total::numeric AS "grandTotal",
           e.name AS employee,
           COALESCE(SUM(ei.quantity), 0)::int AS packets
      FROM employee_orders eo
      JOIN employees e ON e.id = eo.employee_id
      LEFT JOIN employee_order_items ei ON ei.employee_order_id = eo.id
     WHERE eo.status = 'payment_required'
     GROUP BY eo.id, eo.delivery_date, eo.grand_total, e.name
     ORDER BY eo.delivery_date DESC
  `;
  console.log(`\nemployee_orders in payment_required: ${empSide.length}`);
  for (const o of empSide as any[]) {
    console.log(`  ${o.deliveryDate}  Rs ${o.grandTotal}  ${o.packets} pkts  ${o.employee}`);
  }

  // What those held indents are taking out of FGS, per product and date.
  const held = await pgClient`
    SELECT p.code, COALESCE(p.report_alias, p.name) AS name,
           eo.delivery_date::text AS "deliveryDate",
           SUM(ei.quantity)::int AS packets,
           fgs_available(COALESCE(p.stock_source_product_id, p.id), eo.delivery_date) AS "availableNow"
      FROM employee_orders eo
      JOIN employee_order_items ei ON ei.employee_order_id = eo.id
      JOIN products p ON p.id = ei.product_id
     WHERE eo.status = 'payment_required'
     GROUP BY p.code, name, eo.delivery_date, p.stock_source_product_id, p.id
     ORDER BY eo.delivery_date DESC, p.code
  `;
  console.log(`\nFGS stock held by those employee indents:`);
  if (held.length === 0) console.log("  (none)");
  for (const r of held as any[]) {
    console.log(`  ${r.deliveryDate}  ${r.code.padEnd(8)} ${String(r.name).padEnd(26)} ` +
                `${String(r.packets).padStart(5)} pkts held  (available now: ${r.availableNow})`);
  }

  await pgClient.end();
}

main().catch(async (e) => { console.error(e); await pgClient.end(); process.exit(1); });
