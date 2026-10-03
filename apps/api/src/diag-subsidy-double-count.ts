// ═══════════════════════════════════════════════════════════════════════
// diag-subsidy-double-count.ts — SCAN (read-only): from 2026-07-02, find
// every (dealer, delivery_date) where the union subsidy line (PD0191S)
// sits on MORE THAN ONE live order. Root cause: 9c75e4a (Jul 5) made the
// cart checkout pin the subsidy line from ANY non-cancelled order — even
// an already-confirmed subsidy-only order — so the line landed on both.
// d17aaf7 (Jul 15) fixed the pin forward; this script finds the damage.
//
// For each hit it prints both orders, their subsidy lines, what Razorpay
// actually captured, and the ledger debits — enough to decide which copy
// of the line is the phantom (the one money never covered).
//
// USAGE (from apps/api):  npx tsx src/diag-subsidy-double-count.ts
// ═══════════════════════════════════════════════════════════════════════

import { pgClient } from "./lib/db.js";

const FROM = "2026-07-02";

async function main() {
  const [prod] = await pgClient`
    SELECT id::text AS id, name FROM products WHERE code = 'PD0191S' LIMIT 1
  `;
  if (!prod) throw new Error("PD0191S not found");
  console.log(`PD0191S = ${prod.id} (${prod.name})\n`);

  // Every (dealer, delivery_date) since FROM where the subsidy product
  // appears on >1 live order.
  const dupes = await pgClient`
    SELECT o.dealer_id::text AS "dealerId", d.code, d.name,
           o.delivery_date::text AS "deliveryDate",
           COUNT(DISTINCT o.id) AS "orderCount"
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      JOIN dealers d ON d.id = o.dealer_id
     WHERE o.delivery_date >= ${FROM}::date
       AND o.status IN ('confirmed','dispatched','delivered')
       AND oi.product_id = ${prod.id}::uuid
     GROUP BY o.dealer_id, d.code, d.name, o.delivery_date
    HAVING COUNT(DISTINCT o.id) > 1
     ORDER BY o.delivery_date
  `;

  console.log(`── Subsidy line on >1 live order: ${dupes.length} dealer-dates ──\n`);

  let totalPhantom = 0;
  for (const g of dupes) {
    const orders = await pgClient`
      SELECT o.id::text AS id, o.created_at, o.status::text AS status,
             o.payment_mode::text AS pm, o.grand_total::numeric AS gt,
             o.item_count,
             oi.quantity::numeric AS sq, oi.line_total::numeric AS slt,
             COALESCE((SELECT SUM(rp.amount) FROM razorpay_payments rp
                        WHERE rp.order_id = o.id AND rp.status IN ('paid','refunded')
                          AND rp.kind = 'order_payment'), 0)::numeric AS paid,
             COALESCE((SELECT SUM(dl.amount) FROM dealer_ledger dl
                        WHERE dl.reference_id = o.id AND dl.type = 'debit'), 0)::numeric AS "ledgerDebit",
             COALESCE((SELECT SUM(dl.amount) FROM dealer_ledger dl
                        WHERE dl.reference_id = o.id AND dl.type = 'credit'), 0)::numeric AS "ledgerCredit"
        FROM orders o
        JOIN order_items oi ON oi.order_id = o.id AND oi.product_id = ${prod.id}::uuid
       WHERE o.dealer_id = ${g.dealerId}::uuid
         AND o.delivery_date = ${g.deliveryDate}::date
         AND o.status IN ('confirmed','dispatched','delivered')
       ORDER BY o.created_at
    `;
    console.log(`${g.deliveryDate}  ${g.code} ${g.name}`);
    for (const o of orders) {
      console.log(
        `   ${o.id.slice(0, 8)}  ${o.status.padEnd(10)} pm=${String(o.pm).padEnd(6)} ` +
        `items=${o.item_count}  total=${Number(o.gt).toFixed(2).padStart(9)}  ` +
        `subsidy ${Number(o.sq)}x =${Number(o.slt).toFixed(2)}  ` +
        `rzpPaid=${Number(o.paid).toFixed(2)}  ledDr=${Number(o.ledgerDebit).toFixed(2)} ledCr=${Number(o.ledgerCredit).toFixed(2)}`
      );
    }
    // Phantom = every copy beyond the first (chronologically later ones,
    // which the cart pin duplicated).
    const phantom = orders.slice(1).reduce((s, o) => s + Number(o.slt), 0);
    totalPhantom += phantom;
    console.log(`   → phantom subsidy value on later order(s): ₹${phantom.toFixed(2)}\n`);
  }
  console.log(`TOTAL phantom subsidy value: ₹${totalPhantom.toFixed(2)}\n`);

  // Sanity: any dealer-date with >1 live order at all (invariant breaches),
  // to see whether non-subsidy doubles exist too.
  const multi = await pgClient`
    SELECT o.dealer_id::text AS "dealerId", d.code, o.delivery_date::text AS dd,
           COUNT(*) AS n, SUM(o.grand_total)::numeric AS sum,
           BOOL_OR(EXISTS (SELECT 1 FROM order_items oi
                            WHERE oi.order_id = o.id
                              AND oi.product_id = ${prod.id}::uuid)) AS "hasSubsidy"
      FROM orders o
      JOIN dealers d ON d.id = o.dealer_id
     WHERE o.delivery_date >= ${FROM}::date
       AND o.status IN ('confirmed','dispatched','delivered')
     GROUP BY o.dealer_id, d.code, o.delivery_date
    HAVING COUNT(*) > 1
     ORDER BY o.delivery_date
  `;
  console.log(`── Dealer-dates with >1 live order (any kind): ${multi.length} ──`);
  for (const m of multi) {
    console.log(`   ${m.dd}  ${m.code}  n=${m.n}  sum=₹${Number(m.sum).toFixed(2)}  subsidyInvolved=${m.hasSubsidy}`);
  }

  // ── Part 2: ledger movements the Day Book never shows ──
  // Modify deltas (reference_type='adjustment'), wallet cancellation
  // refunds (reference_type='refund' credits), and cancellation credits
  // (reference_type='order' credits, voucher 'Adjustment') since FROM.
  const hidden = await pgClient`
    SELECT (dl.created_at AT TIME ZONE 'Asia/Kolkata')::date::text AS day,
           dl.type::text AS type, dl.reference_type::text AS rt,
           COALESCE(dl.voucher_type,'') AS vt,
           COUNT(*) AS n, SUM(dl.amount)::numeric AS sum
      FROM dealer_ledger dl
     WHERE dl.created_at >= ${FROM}::timestamptz - interval '1 day'
       AND NOT EXISTS (SELECT 1 FROM ledger_adjustments a WHERE a.ledger_entry_id = dl.id)
       AND (
             dl.reference_type = 'adjustment'
          OR (dl.reference_type = 'refund' AND dl.type = 'credit')
          OR (dl.reference_type = 'order' AND dl.type = 'credit')
           )
     GROUP BY 1, 2, 3, 4
     ORDER BY 1
  `;
  console.log(`\n── Ledger rows invisible to the Day Book (since ${FROM}) ──`);
  for (const h of hidden) {
    console.log(`   ${h.day}  ${h.type.padEnd(6)} ref=${String(h.rt).padEnd(11)} voucher=${String(h.vt).padEnd(11)} n=${h.n}  ₹${Number(h.sum).toFixed(2)}`);
  }

  await pgClient.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
