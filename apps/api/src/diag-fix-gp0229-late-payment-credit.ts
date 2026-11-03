// One-off: gate pass GP-0229 (dealer P33) was cancelled as unpaid at 14:39 on
// 24-Sep and its counter QR was paid 40 seconds later (pay_TfosJCvuOQappC,
// Rs 681.83). The receipt was booked against the cancelled sale and nothing
// gave the money back, so the union held Rs 681.83 that showed on P33's
// statement but not in Available Balances — September's closing sat that much
// under the Tally control account.
//
// Credit it to P33's available balance, the same row cancelDirectSale writes
// for a "refund to balance". The voucher is dated 24-Sep so the receipt, the
// (cancelled) sale and the credit all land in the same month; created_at is
// left as now, the audit trail of when the row was really posted.
//
//   npx tsx apps/api/src/diag-fix-gp0229-late-payment-credit.ts          (dry run)
//   APPLY=1 npx tsx apps/api/src/diag-fix-gp0229-late-payment-credit.ts  (write)
import { pgClient } from "./lib/db.js";

const GP_NO = "GP-0229";
const PAYMENT_ID = "pay_TfosJCvuOQappC";
const AMOUNT = 681.83;
const VOUCHER_DATE = "2026-09-24";
const APPLY = process.env.APPLY === "1";

const n = (x: unknown) => Number(x ?? 0);

async function available(asOf: string, dealerId: string) {
  const [r] = await pgClient`
    WITH b AS (
      SELECT d.id, (COALESCE(d.opening_balance,0) + COALESCE((
        SELECT SUM(CASE WHEN dl.type='credit' THEN dl.amount ELSE -dl.amount END)
          FROM dealer_ledger dl
         WHERE dl.dealer_id=d.id AND COALESCE(dl.voucher_type,'')<>'Opening'
           AND COALESCE(dl.voucher_date,
                        (dl.created_at AT TIME ZONE 'Asia/Kolkata')::date) <= ${asOf}::date),0))::numeric bal
        FROM dealers d
       WHERE (d.deleted_at IS NULL
              OR (d.deleted_at AT TIME ZONE 'Asia/Kolkata')::date > ${asOf}::date)
         AND (d.created_at AT TIME ZONE 'Asia/Kolkata')::date <= ${asOf}::date
         AND NOT EXISTS (SELECT 1 FROM routes demo_rt
                          WHERE demo_rt.code = 'DEMO' AND demo_rt.id = d.route_id))
    SELECT COALESCE(SUM(GREATEST(0,bal)),0)::float8 total,
           COALESCE(SUM(bal) FILTER (WHERE id = ${dealerId}::uuid),0)::float8 dealer
      FROM b`;
  return r as any;
}

async function main() {
  const [sale] = await pgClient`
    SELECT ds.id::text AS id, ds.status::text AS status, ds.customer_type::text AS ct,
           ds.customer_id::text AS "dealerId", d.code, d.name
      FROM direct_sales ds JOIN dealers d ON d.id = ds.customer_id
     WHERE ds.gp_no = ${GP_NO}`;
  if (!sale) throw new Error(`${GP_NO} not found`);
  const s = sale as any;

  const [rp] = await pgClient`
    SELECT status::text AS status, amount::float8 AS amount, amount_refunded::float8 AS refunded
      FROM razorpay_payments
     WHERE direct_sale_id = ${s.id}::uuid AND razorpay_payment_id = ${PAYMENT_ID}`;
  const [led] = await pgClient`
    SELECT COALESCE(SUM(CASE WHEN type='credit' THEN amount ELSE -amount END),0)::float8 AS net,
           count(*)::int AS c
      FROM dealer_ledger WHERE reference_id = ${s.id}::uuid`;
  const [rf] = await pgClient`
    SELECT count(*)::int AS c FROM razorpay_refunds WHERE razorpay_payment_id = ${PAYMENT_ID}`;

  console.log(`\n${GP_NO}  ${s.code} ${s.name}  sale ${s.status} (${s.ct})`);
  console.log(`  gateway : ${(rp as any)?.status} ${(rp as any)?.amount}  refunded ${(rp as any)?.refunded}`);
  console.log(`  ledger rows for this sale : ${(led as any).c} (net ${n((led as any).net).toFixed(2)})   bank refunds : ${(rf as any).c}`);

  const show = async (label: string) => {
    const sep = await available("2026-09-30", s.dealerId);
    const now = await available("2099-12-31", s.dealerId);
    console.log(`\n── ${label} ──`);
    console.log(`  ${s.code} balance   @30-Sep ${n(sep.dealer).toFixed(2)}   now ${n(now.dealer).toFixed(2)}`);
    console.log(`  Available Balances @30-Sep ${n(sep.total).toFixed(2)}   now ${n(now.total).toFixed(2)}`);
    return n(now.dealer);
  };

  const balanceNow = await show("BEFORE");

  if ((led as any).c > 0) { console.log("\nThis sale already has ledger rows, nothing to do."); await pgClient.end(); return; }
  if (s.status !== "cancelled" || s.ct !== "agent")
    throw new Error(`expected a cancelled agent sale, found ${s.status}/${s.ct}`);
  if (!rp || (rp as any).status !== "paid" || Math.abs((rp as any).amount - AMOUNT) > 0.001 || (rp as any).refunded > 0.001)
    throw new Error("gateway row is not an unrefunded paid Rs 681.83 — stop and look");
  if ((rf as any).c > 0) throw new Error("a bank refund already exists for this payment — stop and look");

  if (!APPLY) {
    console.log(`\nDRY RUN — would credit ${s.code} Rs ${AMOUNT.toFixed(2)} dated ${VOUCHER_DATE}. Re-run with APPLY=1.`);
    await pgClient.end(); return;
  }

  await pgClient.begin(async (sql) => {
    const inserted = await sql`
      INSERT INTO dealer_ledger
        (dealer_id, type, amount, reference_id, reference_type,
         voucher_type, voucher_date, description, balance_after, performed_by)
      SELECT ${s.dealerId}::uuid, 'credit', ${AMOUNT.toFixed(2)}::numeric,
             ${s.id}::uuid, 'adjustment'::ledger_ref_type,
             'Adjustment', ${VOUCHER_DATE}::date,
             ${`Cancellation credit for gate pass ${GP_NO} (paid after cancel, ${PAYMENT_ID})`},
             ${(balanceNow + AMOUNT).toFixed(2)}::numeric, NULL
       WHERE NOT EXISTS (SELECT 1 FROM dealer_ledger WHERE reference_id = ${s.id}::uuid)
      RETURNING id`;
    if (inserted.length !== 1) throw new Error(`expected 1 row, inserted ${inserted.length} — rolled back`);
  });

  await show("AFTER");
  await pgClient.end();
}

main().catch(async (e) => { console.error(e); await pgClient.end(); process.exit(1); });
