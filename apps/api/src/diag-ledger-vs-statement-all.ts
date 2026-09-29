// Read-only sweep. Replicates finance-dealer-statements.ts exactly (all six
// rails) and compares the statement-derived closing balance against
// dealer_ledger's running balance_after and against AR Aging's open invoices.
//
// A dealer whose ledger drift equals their open AR is the A4/M61 defect: the
// order was settled from the balance, but no dealer_ledger debit was ever
// posted, so the ledger reads high AND the invoice reads unpaid.
import { pgClient } from "./lib/db.js";

async function main() {
  const rows = await pgClient`
    WITH orders_d AS (
      SELECT o.dealer_id, sum(o.grand_total)::float8 AS amt FROM orders o
       WHERE o.status IN ('confirmed','dispatched','delivered') GROUP BY o.dealer_id
    ), gp_d AS (
      SELECT ds.customer_id AS dealer_id, sum(ds.grand_total)::float8 AS amt FROM direct_sales ds
       WHERE ds.customer_type = 'agent' AND ds.status = 'confirmed' GROUP BY ds.customer_id
    ), pay_c AS (
      SELECT p.dealer_id, sum(p.amount)::float8 AS amt FROM payments p GROUP BY p.dealer_id
    ), qr_c AS (
      SELECT rp.dealer_id, sum(rp.amount)::float8 AS amt FROM razorpay_payments rp
       JOIN direct_sales ds ON ds.id = rp.direct_sale_id
       WHERE rp.kind = 'gate_pass' AND rp.status IN ('paid','refunded') AND rp.paid_at IS NOT NULL
       GROUP BY rp.dealer_id
    ), ref_d AS (
      SELECT rf.dealer_id, sum(rf.amount)::float8 AS amt FROM razorpay_refunds rf
       WHERE rf.status = 'processed' GROUP BY rf.dealer_id
    ), adj AS (
      SELECT dl.dealer_id,
             sum(CASE WHEN dl.type='credit' THEN dl.amount ELSE -dl.amount END)::float8 AS amt
        FROM dealer_ledger dl
        LEFT JOIN LATERAL (SELECT a.voucher_type FROM ledger_adjustments a
                            WHERE a.ledger_entry_id = dl.id LIMIT 1) x ON true
       WHERE COALESCE(dl.voucher_type,'') <> 'Opening'
         AND (dl.voucher_no LIKE 'CB-%' OR dl.voucher_no LIKE 'CC-%'
              OR dl.voucher_no LIKE 'CX-%' OR x.voucher_type IS NOT NULL)
       GROUP BY dl.dealer_id
    ), led AS (
      SELECT DISTINCT ON (dealer_id) dealer_id, balance_after::float8 AS bal
        FROM dealer_ledger ORDER BY dealer_id, created_at DESC, id DESC
    ), ar AS (
      SELECT i.dealer_id, sum(i.total_amount - i.paid_amount)::float8 AS open_ar
        FROM invoices i
       WHERE i.total_amount - i.paid_amount > 0.01
         AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = i.order_id AND o.status = 'cancelled')
         AND NOT EXISTS (SELECT 1 FROM direct_sales s WHERE s.id = i.order_id AND s.status <> 'confirmed')
       GROUP BY i.dealer_id
    )
    SELECT d.code, d.name,
           led.bal AS ledger_bal,
           (COALESCE(d.opening_balance,0)::float8
             + COALESCE(pay_c.amt,0) + COALESCE(qr_c.amt,0) + COALESCE(adj.amt,0)
             - COALESCE(orders_d.amt,0) - COALESCE(gp_d.amt,0) - COALESCE(ref_d.amt,0)) AS stmt_bal,
           COALESCE(ar.open_ar,0) AS open_ar
      FROM dealers d
      JOIN led ON led.dealer_id = d.id
      LEFT JOIN orders_d ON orders_d.dealer_id = d.id
      LEFT JOIN gp_d     ON gp_d.dealer_id     = d.id
      LEFT JOIN pay_c    ON pay_c.dealer_id    = d.id
      LEFT JOIN qr_c     ON qr_c.dealer_id     = d.id
      LEFT JOIN ref_d    ON ref_d.dealer_id    = d.id
      LEFT JOIN adj      ON adj.dealer_id      = d.id
      LEFT JOIN ar       ON ar.dealer_id       = d.id
     ORDER BY d.code
  `;
  const all = rows.map((r: any) => ({ ...r, drift: Number(r.ledger_bal) - Number(r.stmt_bal) }));
  const drift = all.filter((r: any) => Math.abs(r.drift) > 0.05);
  console.log(`dealers with a ledger: ${all.length}   |   drifting > 5 paise: ${drift.length}\n`);
  console.log("CODE   LEDGER        STATEMENT      DRIFT       OPEN AR   MATCH  NAME");
  for (const r of drift.sort((a: any, b: any) => Math.abs(b.drift) - Math.abs(a.drift))) {
    const match = Math.abs(r.drift - Number(r.open_ar)) < 0.05 ? "YES" : " - ";
    console.log(
      String(r.code ?? "-").padEnd(6),
      Number(r.ledger_bal).toFixed(2).padStart(12),
      Number(r.stmt_bal).toFixed(2).padStart(13),
      r.drift.toFixed(2).padStart(12),
      Number(r.open_ar).toFixed(2).padStart(10),
      "  " + match, " ", r.name,
    );
  }
  await pgClient.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
