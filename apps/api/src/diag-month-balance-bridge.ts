// Read-only: bridge a month's cash T-account to Finance -> Available Balances.
//
// The accountant builds this by hand every month:
//
//   Opening balance (Available Balances, as-on last day of prev month)
//   + Total receipts        (money in, cash lens)
//   - Month cash sales      (Sales Reports -> Cash Sales)
//   - Refunds               (razorpay_refunds processed in the month)
//   = Closing balance       (should equal Available Balances as-on month end)
//
// The two sides are built from DIFFERENT models: Cash Sales sums order LINE
// totals and ignores credit supply, while Available Balances folds
// dealer_ledger and clips negative balances at zero. So they drift. This
// prints the drift dealer by dealer so the residual can be named rather than
// written off.
//
//   npx tsx apps/api/src/diag-month-balance-bridge.ts 2026-08
import { pgClient } from "./lib/db.js";

const ym = process.argv[2] ?? "2026-08";
const FROM = `${ym}-01`;
const TO = new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)).toISOString().slice(0, 10);
const PREV = new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7) - 1, 0)).toISOString().slice(0, 10);

const n = (x: unknown) => Number(x ?? 0);
const f = (v: number) => v.toFixed(2).padStart(15);

/** Finance -> Available Balances: sum of max(0, ledger balance) as at `asOf`. */
async function availableBalances(asOf: string) {
  const [row] = await pgClient`
    WITH dealer_balance AS (
      SELECT (
        COALESCE(d.opening_balance, 0)
        + COALESCE((
            SELECT SUM(CASE WHEN dl.type = 'credit' THEN dl.amount ELSE -dl.amount END)
              FROM dealer_ledger dl
             WHERE dl.dealer_id = d.id
               AND COALESCE(dl.voucher_type, '') <> 'Opening'
               AND COALESCE(dl.voucher_date,
                            (dl.created_at AT TIME ZONE 'Asia/Kolkata')::date) <= ${asOf}::date
          ), 0)
      )::numeric AS bal
      FROM dealers d
      -- Membership as at the as-on date, both ends. Mirrors
      -- finance-credit-control.ts; keep the two in step.
      WHERE (d.deleted_at IS NULL
             OR (d.deleted_at AT TIME ZONE 'Asia/Kolkata')::date > ${asOf}::date)
        AND (d.created_at AT TIME ZONE 'Asia/Kolkata')::date <= ${asOf}::date
        -- Play Store demo route: a reviewer's test activity is not the
        -- union's money. Excluded in SQL exactly as the screen does it, so
        -- the two cannot drift.
        AND NOT EXISTS (SELECT 1 FROM routes demo_rt
                         WHERE demo_rt.code = 'DEMO' AND demo_rt.id = d.route_id)
    )
    SELECT COALESCE(SUM(GREATEST(0, bal)), 0)::float8 AS total
      FROM dealer_balance`;
  return { total: n((row as any).total) };
}

async function main() {
  const open = await availableBalances(PREV);
  const close = await availableBalances(TO);

  // Sales Reports -> Cash Sales: LINE totals, excluding credit supply and the
  // employee subsidy (both settled off the cash rail).
  const [os] = await pgClient`
    SELECT COALESCE(SUM(li.s), 0)::float8 v
      FROM orders o
      JOIN dealers d ON d.id = o.dealer_id
      JOIN LATERAL (SELECT COALESCE(SUM(oi.line_total), 0)::numeric s
                      FROM order_items oi WHERE oi.order_id = o.id) li ON true
     WHERE o.status IN ('confirmed', 'dispatched', 'delivered')
       AND o.created_at < ${TO}::date + interval '3 days'
       AND COALESCE(o.delivery_date,
                    (o.created_at AT TIME ZONE 'Asia/Kolkata')::date)
           BETWEEN ${FROM}::date AND ${TO}::date
       AND NOT (COALESCE(d.customer_type::text, '') LIKE 'Credit Inst%'
                AND o.payment_mode::text = 'credit')`;
  const [gs] = await pgClient`
    SELECT COALESCE(SUM(li.s), 0)::float8 v
      FROM direct_sales ds
      JOIN LATERAL (SELECT COALESCE(SUM(dsi.line_total), 0)::numeric s
                      FROM direct_sale_items dsi WHERE dsi.direct_sale_id = ds.id) li ON true
     WHERE ds.status = 'confirmed'
       AND ds.sale_date BETWEEN ${FROM}::date AND ${TO}::date
       AND ds.payment_mode::text <> 'credit'
       AND ds.customer_type = 'agent'`;
  const sales = n((os as any).v) + n((gs as any).v);

  // Receipts on the same lens: every payment except a credit institution's
  // month-end settlement (a credit institution paying at checkout IS cash).
  const receipts = await pgClient`
    SELECT p.mode::text AS mode, count(*)::int AS c, SUM(p.amount)::float8 AS t
      FROM payments p
      JOIN dealers d ON d.id = p.dealer_id
      LEFT JOIN LATERAL (SELECT x.kind::text AS k FROM razorpay_payments x
                          WHERE p.reference IS NOT NULL
                            AND x.razorpay_payment_id = p.reference LIMIT 1) rp ON true
     WHERE p.received_date BETWEEN ${FROM}::date AND ${TO}::date
       AND (COALESCE(d.customer_type::text, '') NOT LIKE 'Credit Inst%' OR rp.k IS NOT NULL)
     GROUP BY 1 ORDER BY 3 DESC`;

  const [rf] = await pgClient`
    SELECT COALESCE(SUM(rf.amount), 0)::float8 v, count(*)::int c
      FROM razorpay_refunds rf
     WHERE rf.status = 'processed'
       AND (COALESCE(rf.processed_at, rf.created_at) AT TIME ZONE 'Asia/Kolkata')::date
           BETWEEN ${FROM}::date AND ${TO}::date`;

  // The DEMO account is excluded inside availableBalances(), the same way
  // Finance -> Available Balances does it, so these are already net of it.
  const open0 = open.total;
  const close0 = close.total;

  console.log(`\n== ${ym}  cash T-account vs Available Balances ==\n`);
  console.log(`Opening balance (as-on ${PREV})   ${f(open0)}`);
  let rt = 0;
  for (const r of receipts as any[]) {
    rt += n(r.t);
    console.log(`  receipts ${String(r.mode).padEnd(8)} ${String(r.c).padStart(6)} ${f(n(r.t))}`);
  }
  console.log(`Total receipts                     ${f(rt)}`);
  console.log(`Month cash sales                   ${f(-sales)}`);
  console.log(`Refunds (${n((rf as any).c)})                        ${f(-n((rf as any).v))}`);
  const derived = open0 + rt - sales - n((rf as any).v);
  console.log(`  ---------------------------------------------`);
  console.log(`Derived closing                    ${f(derived)}`);
  console.log(`Available Balances (as-on ${TO}) ${f(close0)}   (DEMO route excluded, as on screen)`);
  console.log(`DIFFERENCE                         ${f(close0 - derived)}\n`);

  // Where the difference lives, dealer by dealer.
  const rows = await pgClient`
    WITH bal AS (
      SELECT d.id, d.code, d.name,
             EXISTS (SELECT 1 FROM routes demo_rt
                      WHERE demo_rt.code = 'DEMO' AND demo_rt.id = d.route_id) AS is_demo,
             (d.deleted_at AT TIME ZONE 'Asia/Kolkata')::date AS del,
             (d.created_at AT TIME ZONE 'Asia/Kolkata')::date AS crd,
             (COALESCE(d.opening_balance,0) + COALESCE((
                SELECT SUM(CASE WHEN dl.type='credit' THEN dl.amount ELSE -dl.amount END)
                  FROM dealer_ledger dl WHERE dl.dealer_id=d.id
                   AND COALESCE(dl.voucher_type,'')<>'Opening'
                   AND COALESCE(dl.voucher_date,
                                (dl.created_at AT TIME ZONE 'Asia/Kolkata')::date) <= ${PREV}::date),0))::float8 AS b0,
             (COALESCE(d.opening_balance,0) + COALESCE((
                SELECT SUM(CASE WHEN dl.type='credit' THEN dl.amount ELSE -dl.amount END)
                  FROM dealer_ledger dl WHERE dl.dealer_id=d.id
                   AND COALESCE(dl.voucher_type,'')<>'Opening'
                   AND COALESCE(dl.voucher_date,
                                (dl.created_at AT TIME ZONE 'Asia/Kolkata')::date) <= ${TO}::date),0))::float8 AS b1
        FROM dealers d),
    os AS (SELECT o.dealer_id did, SUM(li.s)::float8 v FROM orders o JOIN dealers d ON d.id=o.dealer_id
             JOIN LATERAL (SELECT COALESCE(SUM(oi.line_total),0)::numeric s
                             FROM order_items oi WHERE oi.order_id=o.id) li ON true
            WHERE o.status IN ('confirmed','dispatched','delivered')
              AND o.created_at < ${TO}::date + interval '3 days'
              AND COALESCE(o.delivery_date,(o.created_at AT TIME ZONE 'Asia/Kolkata')::date)
                  BETWEEN ${FROM}::date AND ${TO}::date
              AND NOT (COALESCE(d.customer_type::text,'') LIKE 'Credit Inst%'
                       AND o.payment_mode::text='credit') GROUP BY 1),
    gsl AS (SELECT ds.customer_id did, SUM(li.s)::float8 v FROM direct_sales ds
              JOIN LATERAL (SELECT COALESCE(SUM(dsi.line_total),0)::numeric s
                              FROM direct_sale_items dsi WHERE dsi.direct_sale_id=ds.id) li ON true
             WHERE ds.status='confirmed' AND ds.sale_date BETWEEN ${FROM}::date AND ${TO}::date
               AND ds.payment_mode::text<>'credit' AND ds.customer_type='agent' GROUP BY 1),
    rc AS (SELECT p.dealer_id did, SUM(p.amount)::float8 v FROM payments p
             JOIN dealers d ON d.id=p.dealer_id
             LEFT JOIN LATERAL (SELECT x.kind::text k FROM razorpay_payments x
                                 WHERE p.reference IS NOT NULL
                                   AND x.razorpay_payment_id=p.reference LIMIT 1) rp ON true
            WHERE p.received_date BETWEEN ${FROM}::date AND ${TO}::date
              AND (COALESCE(d.customer_type::text,'') NOT LIKE 'Credit Inst%'
                   OR rp.k IS NOT NULL) GROUP BY 1),
    rr AS (SELECT rf.dealer_id did, SUM(rf.amount)::float8 v FROM razorpay_refunds rf
            WHERE rf.status='processed'
              AND (COALESCE(rf.processed_at,rf.created_at) AT TIME ZONE 'Asia/Kolkata')::date
                  BETWEEN ${FROM}::date AND ${TO}::date GROUP BY 1)
    SELECT b.code, b.name, b.is_demo, b.del::text AS del, b.crd::text AS crd, b.b0, b.b1,
           COALESCE(os.v,0)::float8 osales, COALESCE(gsl.v,0)::float8 gsales,
           COALESCE(rc.v,0)::float8 recs, COALESCE(rr.v,0)::float8 refs
      FROM bal b
      LEFT JOIN os ON os.did=b.id LEFT JOIN gsl ON gsl.did=b.id
      LEFT JOIN rc ON rc.did=b.id LEFT JOIN rr ON rr.did=b.id`;

  const items = (rows as any[]).map((r) => {
    const onBooks = (asOf: string) =>
      r.crd <= asOf && (!r.del || r.del > asOf) && !r.is_demo;
    const a0 = onBooks(PREV) ? Math.max(0, n(r.b0)) : 0;
    const a1 = onBooks(TO) ? Math.max(0, n(r.b1)) : 0;
    const sold = n(r.osales) + n(r.gsales);
    return { ...r, delta: (a1 - a0) - (n(r.recs) - sold - n(r.refs)) };
  });
  const named = items
    .filter((r) => Math.abs(r.delta) >= 1)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const pennies = items.filter((r) => Math.abs(r.delta) > 0.004 && Math.abs(r.delta) < 1);
  console.log("Named contributors (delta >= 1 rupee):");
  for (const r of named) {
    const who = String(r.code ?? "(no code)").padEnd(9);
    const life = r.del ? `deleted ${r.del}` : "live       ";
    console.log(`  ${who} ${String(r.name).slice(0, 28).padEnd(28)} ${life}  delta ${f(r.delta)}`);
  }
  console.log(`Rounding tail: ${pennies.length} dealers  ${f(pennies.reduce((a, r) => a + r.delta, 0))}`);
  console.log(`Sum of all deltas ${f(items.reduce((a, r) => a + r.delta, 0))}\n`);
  await pgClient.end();
}

main().catch(async (e) => { console.error(e); await pgClient.end(); process.exit(1); });
