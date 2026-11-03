// One-off: gate pass GP-0229 (dealer P33, 2 x GHEE SACHET 500ML, Rs 681.83)
// was cancelled by mistake at 14:39 on 24-Sep as "Customer did not pay the
// counter QR". The goods had been handed over and the QR was paid 40 seconds
// later (pay_TfosJCvuOQappC). So the sale is real: put it back.
//
// Undoes exactly what cancelDirectSale did, plus the balance credit posted
// earlier today on the belief that the sale was genuinely cancelled:
//
//   direct_sales      status back to 'confirmed', cancel fields cleared, the
//                     history kept in `notes`; dispatched_at stamped, as every
//                     other pass that left the counter that day carries one
//   gate_pass_items   issued quantity restored from direct_sale_items
//   products.stock    the 2 units the cancel put back are taken out again
//   dealer_ledger     today's Rs 681.83 cancellation credit removed — the
//                     receipt now pays for a standing sale, so P33 is owed
//                     nothing. Deleted rather than reversed: it was posted
//                     minutes ago on a wrong premise, nothing was built on it,
//                     and a credit/debit pair would show in the Day Book as
//                     balance movements that never happened.
//   razorpay_payments the stale "Sale cancelled" error text cleared
//
// FGS needs nothing: fgs_day() counts direct_sales with status = 'confirmed'
// by sale_date, so the 2 units read as out on 24-Sep again by themselves. The
// invoice was never rewritten by the cancel and already reads PAID.
//
//   npx tsx apps/api/src/diag-restore-gp0229-cancelled-by-mistake.ts          (dry run)
//   APPLY=1 npx tsx apps/api/src/diag-restore-gp0229-cancelled-by-mistake.ts  (write)
import { pgClient } from "./lib/db.js";

const GP_NO = "GP-0229";
const PAYMENT_ID = "pay_TfosJCvuOQappC";
const CREDIT_LEDGER_ID = "dea1ec95-4507-4e25-bb88-1167df4ad591";
const AMOUNT = 681.83;
const APPLY = process.env.APPLY === "1";

const n = (x: unknown) => Number(x ?? 0);

async function snapshot(label: string) {
  const [s] = await pgClient`
    SELECT ds.id::text AS id, ds.status, ds.customer_id::text AS "dealerId",
           ds.dispatched_at::text AS dispatched, ds.cancelled_at::text AS cancelled, ds.notes,
           (SELECT COALESCE(SUM(CASE WHEN dl.type='credit' THEN dl.amount ELSE -dl.amount END),0)
              FROM dealer_ledger dl
             WHERE dl.dealer_id = ds.customer_id AND COALESCE(dl.voucher_type,'')<>'Opening')::float8
             + (SELECT COALESCE(d.opening_balance,0) FROM dealers d WHERE d.id = ds.customer_id)::float8 AS bal
      FROM direct_sales ds WHERE ds.gp_no = ${GP_NO}`;
  if (!s) throw new Error(`${GP_NO} not found`);
  const sale = s as any;
  const items = await pgClient`
    SELECT i.product_name, i.quantity AS sold, p.stock,
           (SELECT g.quantity FROM gate_pass_items g
             WHERE g.direct_sale_id = i.direct_sale_id AND g.product_id = i.product_id) AS issued
      FROM direct_sale_items i JOIN products p ON p.id = i.product_id
     WHERE i.direct_sale_id = ${sale.id}::uuid`;
  const [led] = await pgClient`
    SELECT count(*)::int AS c FROM dealer_ledger WHERE reference_id = ${sale.id}::uuid`;
  const [tile] = await pgClient`
    WITH b AS (
      SELECT (COALESCE(d.opening_balance,0) + COALESCE((
        SELECT SUM(CASE WHEN dl.type='credit' THEN dl.amount ELSE -dl.amount END)
          FROM dealer_ledger dl
         WHERE dl.dealer_id=d.id AND COALESCE(dl.voucher_type,'')<>'Opening'
           AND COALESCE(dl.voucher_date,(dl.created_at AT TIME ZONE 'Asia/Kolkata')::date) <= '2026-09-30'::date),0))::numeric bal
        FROM dealers d
       WHERE (d.deleted_at IS NULL OR (d.deleted_at AT TIME ZONE 'Asia/Kolkata')::date > '2026-09-30'::date)
         AND (d.created_at AT TIME ZONE 'Asia/Kolkata')::date <= '2026-09-30'::date
         AND NOT EXISTS (SELECT 1 FROM routes r WHERE r.code = 'DEMO' AND r.id = d.route_id))
    SELECT COALESCE(SUM(GREATEST(0,bal)),0)::float8 AS total FROM b`;

  console.log(`\n── ${label} ──`);
  console.log(`  sale        : ${sale.status}  dispatched_at=${sale.dispatched}  cancelled_at=${sale.cancelled}`);
  console.log(`  notes       : ${sale.notes || "(empty)"}`);
  for (const it of items as any[])
    console.log(`  item        : ${it.product_name}  sold ${it.sold}  gate-pass issued ${it.issued}  products.stock ${it.stock}`);
  console.log(`  P33 balance : ${n(sale.bal).toFixed(2)}   ledger rows on this sale: ${(led as any).c}`);
  console.log(`  Available Balances @30-Sep : ${n((tile as any).total).toFixed(2)}`);
  return sale;
}

async function main() {
  const before = await snapshot("BEFORE");
  if (before.status === "confirmed") { console.log("\nAlready restored, nothing to do."); await pgClient.end(); return; }

  if (!APPLY) {
    console.log(`\nDRY RUN — would restore ${GP_NO} to confirmed. Re-run with APPLY=1.`);
    await pgClient.end(); return;
  }

  await pgClient.begin(async (sql) => {
    const [sale] = await sql`
      SELECT id::text AS id, status, customer_id::text AS "dealerId",
             to_char(cancelled_at AT TIME ZONE 'Asia/Kolkata', 'DD-Mon-YYYY HH24:MI') AS "cancelledAt",
             cancellation_reason AS reason
        FROM direct_sales WHERE gp_no = ${GP_NO} FOR UPDATE`;
    const s = sale as any;
    if (s.status !== "cancelled") throw new Error(`expected cancelled, found ${s.status}`);

    // The payment must be there and untouched, or the sale is not paid for.
    const [rp] = await sql`
      SELECT id::text AS id, to_char(paid_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "paidAt"
        FROM razorpay_payments
       WHERE direct_sale_id = ${s.id}::uuid AND razorpay_payment_id = ${PAYMENT_ID}
         AND status = 'paid' AND amount = ${AMOUNT.toFixed(2)}::numeric AND amount_refunded = 0`;
    if (!rp) throw new Error("no unrefunded paid Rs 681.83 gateway row — rolled back");

    // Today's credit: must be the only ledger row on the sale and the newest
    // on the dealer, i.e. nothing has been spent from or posted after it.
    const dropped = await sql`
      DELETE FROM dealer_ledger dl
       WHERE dl.id = ${CREDIT_LEDGER_ID}::uuid
         AND dl.dealer_id = ${s.dealerId}::uuid
         AND dl.reference_id = ${s.id}::uuid
         AND dl.type = 'credit' AND dl.amount = ${AMOUNT.toFixed(2)}::numeric
         AND NOT EXISTS (SELECT 1 FROM dealer_ledger later
                          WHERE later.dealer_id = dl.dealer_id AND later.created_at > dl.created_at)
      RETURNING id`;
    if (dropped.length !== 1) throw new Error(`expected to remove 1 credit, removed ${dropped.length} — rolled back`);
    const [left] = await sql`SELECT count(*)::int AS c FROM dealer_ledger WHERE reference_id = ${s.id}::uuid`;
    if ((left as any).c !== 0) throw new Error("other ledger rows reference this sale — rolled back");

    const restored = await sql`
      UPDATE direct_sales
         SET status = 'confirmed',
             cancelled_at = NULL, cancellation_reason = NULL, cancelled_by = NULL,
             dispatched_at = COALESCE(dispatched_at, ${(rp as any).paidAt}::timestamptz),
             notes = trim(COALESCE(notes, '') || ' ' || ${
               `Cancelled by mistake on ${s.cancelledAt} (reason given: ${s.reason}); ` +
               `restored 12-Oct-2026 — goods were delivered and UPI ${PAYMENT_ID} was received.`
             }),
             updated_at = now()
       WHERE id = ${s.id}::uuid AND status = 'cancelled'
      RETURNING id`;
    if (restored.length !== 1) throw new Error("sale not restored — rolled back");

    const issued = await sql`
      UPDATE gate_pass_items g
         SET quantity = i.quantity, updated_at = now()
        FROM direct_sale_items i
       WHERE g.direct_sale_id = ${s.id}::uuid
         AND i.direct_sale_id = g.direct_sale_id AND i.product_id = g.product_id
         AND g.quantity = 0
      RETURNING g.id`;
    const [itemCount] = await sql`SELECT count(*)::int AS c FROM direct_sale_items WHERE direct_sale_id = ${s.id}::uuid`;
    if (issued.length !== (itemCount as any).c)
      throw new Error(`gate pass items restored ${issued.length} of ${(itemCount as any).c} — rolled back`);

    await sql`
      UPDATE products p
         SET stock = p.stock - i.quantity, updated_at = now()
        FROM direct_sale_items i
       WHERE i.direct_sale_id = ${s.id}::uuid AND p.id = i.product_id`;

    await sql`
      UPDATE razorpay_payments SET error_description = NULL, updated_at = now()
       WHERE id = ${(rp as any).id}::uuid`;
  });

  await snapshot("AFTER");
  await pgClient.end();
}

main().catch(async (e) => { console.error(e); await pgClient.end(); process.exit(1); });
