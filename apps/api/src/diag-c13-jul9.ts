// Read-only: C13's orders created/delivering Jul 7–13, with items,
// payments and ledger, to pin down the day-book double count shape.
import { pgClient } from "./lib/db.js";

async function main() {
  const [d] = await pgClient`SELECT id::text AS id, code, name FROM dealers WHERE code = 'C13' LIMIT 1`;
  console.log(`${d!.code} ${d!.name} ${d!.id}\n`);

  const orders = await pgClient`
    SELECT o.id::text AS id,
           (o.created_at AT TIME ZONE 'Asia/Kolkata')::text AS created_ist,
           o.delivery_date::text AS dd, o.status::text AS st,
           o.payment_mode::text AS pm, o.grand_total::numeric AS gt,
           o.item_count, o.cancellation_reason
      FROM orders o
     WHERE o.dealer_id = ${d!.id}::uuid
       AND o.created_at >= '2026-07-06'::date AND o.created_at < '2026-07-14'::date
     ORDER BY o.created_at
  `;
  for (const o of orders) {
    console.log(`${o.id.slice(0,8)}  created ${o.created_ist}  delivery ${o.dd}  ${o.st}/${o.pm}  ₹${Number(o.gt).toFixed(2)}  items=${o.item_count}${o.cancellation_reason ? "  [" + o.cancellation_reason.slice(0, 60) + "]" : ""}`);
    const items = await pgClient`
      SELECT oi.product_name, oi.quantity::numeric AS q, oi.line_total::numeric AS lt, p.code
        FROM order_items oi JOIN products p ON p.id = oi.product_id
       WHERE oi.order_id = ${o.id}::uuid ORDER BY oi.product_name
    `;
    for (const i of items) {
      console.log(`      ${String(i.code).padEnd(8)} ${i.product_name.padEnd(28)} x${Number(i.q)}  ₹${Number(i.lt).toFixed(2)}`);
    }
    const led = await pgClient`
      SELECT dl.type::text AS t, dl.amount::numeric AS a, dl.reference_type::text AS rt,
             COALESCE(dl.voucher_type,'') AS vt, dl.description,
             (dl.created_at AT TIME ZONE 'Asia/Kolkata')::text AS at
        FROM dealer_ledger dl WHERE dl.reference_id = ${o.id}::uuid ORDER BY dl.created_at
    `;
    for (const l of led) {
      console.log(`      LEDGER ${l.t} ₹${Number(l.a).toFixed(2)} ref=${l.rt} v=${l.vt} @${l.at}  ${String(l.description).slice(0, 70)}`);
    }
    const rp = await pgClient`
      SELECT rp.status::text AS st, rp.amount::numeric AS a, rp.razorpay_payment_id AS pid
        FROM razorpay_payments rp WHERE rp.order_id = ${o.id}::uuid ORDER BY rp.created_at
    `;
    for (const r of rp) {
      console.log(`      RZP ${r.st} ₹${Number(r.a).toFixed(2)} ${r.pid ?? ""}`);
    }
  }
  await pgClient.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
