// One-off: the cancellation credit for order 8578ac56 (dealer S217) was posted
// on 1-Sep for an order paid by UPI on 30-Aug and cancelled at month end. The
// receipt sat in August while the credit sat in September, leaving August's
// closing balance Rs 882.47 short. Back-date the voucher to 30-Aug so the
// receipt, the (cancelled) sale and the credit all land in the same month.
//
// created_at is deliberately NOT touched: it stays the audit trail of when the
// row was really posted.
//
//   npx tsx apps/api/src/diag-backdate-s217-cancel-credit.ts          (dry run)
//   APPLY=1 npx tsx apps/api/src/diag-backdate-s217-cancel-credit.ts  (write)
import { pgClient } from "./lib/db.js";

const LEDGER_ID = "2d6821ed-f4e7-46cf-8797-eb5a72f4afea";
const NEW_DATE = "2026-08-30";
const APPLY = process.env.APPLY === "1";

async function balances(asOf: string) {
  const [r] = await pgClient`
    WITH b AS (
      SELECT d.code, (COALESCE(d.opening_balance,0) + COALESCE((
        SELECT SUM(CASE WHEN dl.type='credit' THEN dl.amount ELSE -dl.amount END)
          FROM dealer_ledger dl
         WHERE dl.dealer_id=d.id AND COALESCE(dl.voucher_type,'')<>'Opening'
           AND COALESCE(dl.voucher_date,
                        (dl.created_at AT TIME ZONE 'Asia/Kolkata')::date) <= ${asOf}::date),0))::numeric bal
        FROM dealers d
       WHERE d.deleted_at IS NULL
         AND (d.created_at AT TIME ZONE 'Asia/Kolkata')::date <= ${asOf}::date)
    SELECT COALESCE(SUM(GREATEST(0,bal)),0)::float8 total,
           COALESCE(SUM(GREATEST(0,bal)) FILTER (WHERE code='DEMO'),0)::float8 demo,
           COALESCE(SUM(GREATEST(0,bal)) FILTER (WHERE code='S217'),0)::float8 s217
      FROM b`;
  return r as any;
}

async function show(label: string) {
  const [row] = await pgClient`
    SELECT id::text, type::text, amount::float8 AS amount, voucher_date::text AS vd,
           (created_at AT TIME ZONE 'Asia/Kolkata')::text AS posted, description
      FROM dealer_ledger WHERE id = ${LEDGER_ID}::uuid`;
  if (!row) throw new Error(`ledger row ${LEDGER_ID} not found`);
  const a = await balances("2026-08-31");
  console.log(`\n── ${label} ──`);
  console.log(`  ledger row : ${(row as any).type} ${(row as any).amount}  voucher_date=${(row as any).vd}  posted=${(row as any).posted}`);
  console.log(`  ${(row as any).description}`);
  console.log(`  Available Balances @31-Aug : ${Number(a.total).toFixed(2)}  (DEMO ${Number(a.demo).toFixed(2)}, S217 ${Number(a.s217).toFixed(2)})`);
  console.log(`  excluding DEMO             : ${(Number(a.total) - Number(a.demo)).toFixed(2)}`);
  return row as any;
}

async function main() {
  const before = await show("BEFORE");
  if (before.vd === NEW_DATE) { console.log("\nAlready back-dated, nothing to do."); await pgClient.end(); return; }

  if (!APPLY) {
    console.log(`\nDRY RUN — would set voucher_date ${before.vd} -> ${NEW_DATE}. Re-run with APPLY=1.`);
    await pgClient.end(); return;
  }

  await pgClient.begin(async (sql) => {
    const updated = await sql`
      UPDATE dealer_ledger SET voucher_date = ${NEW_DATE}::date
       WHERE id = ${LEDGER_ID}::uuid AND voucher_date = ${before.vd}::date
       RETURNING id`;
    if (updated.length !== 1) throw new Error(`expected 1 row, updated ${updated.length} — rolled back`);
  });

  await show("AFTER");
  await pgClient.end();
}

main().catch(async (e) => { console.error(e); await pgClient.end(); process.exit(1); });
