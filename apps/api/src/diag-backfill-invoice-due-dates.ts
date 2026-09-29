// ═══════════════════════════════════════════════════════════════════════
// diag-backfill-invoice-due-dates.ts
//
// Stamps invoices.due_date on the rows minted before the mints learned to
// write it. The column was NULL on all 6,651 invoices in prod, and because
// AR Aging and the finance dashboard filtered `due_date IS NOT NULL`, both
// reported ₹0 outstanding — indistinguishable from "nobody owes us
// anything". Those queries now COALESCE to invoice_date, so this backfill
// is about giving each invoice its REAL term rather than making the report
// work at all.
//
// Terms come from resolveTermDays() in lib/invoice-settlement.ts — the same
// function both mints use, so backfilled and future rows cannot disagree:
//   • credit institutions ('Credit Inst-*')  30 days  (monthly account)
//   • everyone else                           7 days  (migration 0015's term)
// Counter sales (direct_sales) are cash and carry: due the day of issue.
//
// due_date is derived from invoice_date, the LEGAL date of issue, converted
// to IST first so a late-evening invoice does not land a day early.
//
// Only fills NULLs — an invoice that already has a due date keeps it, so
// this is safe to re-run and will not silently re-term anything a human set.
//
// USAGE (from apps/api):
//   npx tsx src/diag-backfill-invoice-due-dates.ts           ← DRY RUN
//   npx tsx src/diag-backfill-invoice-due-dates.ts --apply    ← writes
// ═══════════════════════════════════════════════════════════════════════
import { pgClient } from "./lib/db.js";
import {
  CREDIT_INSTITUTION_TERM_DAYS,
  STANDARD_TERM_DAYS,
} from "./lib/invoice-settlement.js";

const APPLY = process.argv.includes("--apply");

const inr = (n: number) =>
  "₹" + n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function main() {
  console.log(APPLY ? "\n*** APPLY MODE - this will write ***\n" : "\n--- DRY RUN (no writes) ---\n");

  const [before] = await pgClient`
    SELECT count(*)::int AS total, count(due_date)::int AS with_due FROM invoices
  `;
  console.log(`${before!.total} invoices, ${before!.with_due} already have a due date.\n`);

  // The term each invoice will get. A counter sale has no dealer terms — it
  // is settled at the counter — so it is due on the issue date. An employee
  // invoice is salary recovery settled off-system; it has no dealer_id and
  // never reaches AR aging, but it gets the standard term so no invoice in
  // the table is left without one.
  const preview = await pgClient`
    SELECT
      CASE
        WHEN ds.id IS NOT NULL                            THEN 'counter sale (0d)'
        WHEN d.customer_type::text LIKE 'Credit Inst%'    THEN 'credit institution (30d)'
        WHEN i.dealer_id IS NULL                          THEN 'employee indent (7d)'
        ELSE 'dealer (7d)'
      END AS term,
      count(*)::int AS n,
      count(*) FILTER (WHERE i.payment_status <> 'paid')::int AS still_open,
      round(sum(CASE WHEN i.payment_status <> 'paid'
                     THEN i.total_amount - COALESCE(i.paid_amount, 0) ELSE 0 END), 2) AS outstanding
    FROM invoices i
    LEFT JOIN dealers d       ON d.id  = i.dealer_id
    LEFT JOIN direct_sales ds ON ds.id = i.order_id
    WHERE i.due_date IS NULL
    GROUP BY 1 ORDER BY n DESC
  `;
  console.log("-- Terms to be applied ------------------------------------");
  console.table(preview);

  // What the aging buckets will look like once the dates land.
  const buckets = await pgClient`
    WITH x AS (
      SELECT
        (i.invoice_date AT TIME ZONE 'Asia/Kolkata')::date
          + CASE
              WHEN ds.id IS NOT NULL                         THEN 0
              WHEN d.customer_type::text LIKE 'Credit Inst%' THEN ${CREDIT_INSTITUTION_TERM_DAYS}::int
              ELSE ${STANDARD_TERM_DAYS}::int
            END AS due,
        (i.total_amount - COALESCE(i.paid_amount, 0)) AS outstanding
      FROM invoices i
      LEFT JOIN dealers d       ON d.id  = i.dealer_id
      LEFT JOIN direct_sales ds ON ds.id = i.order_id
      WHERE i.payment_status <> 'paid'
        AND (i.total_amount - COALESCE(i.paid_amount, 0)) > 0
    )
    SELECT
      CASE
        WHEN due >= CURRENT_DATE                    THEN 'current'
        WHEN (CURRENT_DATE - due) BETWEEN 1  AND 30 THEN 'b1_30'
        WHEN (CURRENT_DATE - due) BETWEEN 31 AND 60 THEN 'b31_60'
        WHEN (CURRENT_DATE - due) BETWEEN 61 AND 90 THEN 'b61_90'
        ELSE 'b90_plus'
      END AS bucket,
      count(*)::int AS invoices,
      round(sum(outstanding), 2) AS amount
    FROM x GROUP BY 1 ORDER BY 1
  `;
  console.log("\n-- Resulting AR aging buckets -----------------------------");
  console.table(buckets);
  const total = buckets.reduce((s: number, b: any) => s + Number(b.amount), 0);
  console.log(`Total receivable: ${inr(total)}`);

  if (!APPLY) {
    console.log("\nDry run complete. Re-run with --apply to write these due dates.");
    return;
  }

  // One set-based UPDATE: 6.6k rows, no per-row round-trip (the settlement
  // backfill's row-at-a-time loop took ~10 minutes through the pooler).
  const written = await pgClient`
    UPDATE invoices i
       SET due_date = (i.invoice_date AT TIME ZONE 'Asia/Kolkata')::date
                    + CASE
                        WHEN EXISTS (
                          SELECT 1 FROM direct_sales ds WHERE ds.id = i.order_id
                        ) THEN 0
                        WHEN (
                          SELECT d.customer_type::text FROM dealers d WHERE d.id = i.dealer_id
                        ) LIKE 'Credit Inst%' THEN ${CREDIT_INSTITUTION_TERM_DAYS}::int
                        ELSE ${STANDARD_TERM_DAYS}::int
                      END
     WHERE i.due_date IS NULL
     RETURNING i.id
  `;
  console.log(`\nDone. ${written.length} invoices stamped.`);
}

await main();
await pgClient.end();
