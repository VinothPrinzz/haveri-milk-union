// READ ONLY. Post-migration-0071 check: every pre-existing direct sale is
// still live, still worth what it was, and nothing got cancelled.
//
// USAGE (from apps/api):  npx tsx src/diag-verify-0071.ts
import { pgClient } from "./lib/db.js";

const [tot] = (await pgClient`
  SELECT count(*)::int AS n,
         count(*) FILTER (WHERE status = 'confirmed')::int AS confirmed,
         count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
         COALESCE(SUM(grand_total), 0)::numeric AS "totalValue",
         count(*) FILTER (WHERE cancelled_at IS NOT NULL)::int AS "withCancelledAt"
    FROM direct_sales
`) as any[];

console.log("── every direct sale on file ──");
console.log(`  rows            : ${tot.n}`);
console.log(`  confirmed (live): ${tot.confirmed}`);
console.log(`  cancelled       : ${tot.cancelled}   ← must be 0`);
console.log(`  cancelled_at set: ${tot.withCancelledAt}   ← must be 0`);
console.log(`  total value     : ₹${tot.totalValue}`);

const byType = (await pgClient`
  SELECT customer_type::text AS t, status,
         count(*)::int AS n, COALESCE(SUM(grand_total),0)::numeric AS value
    FROM direct_sales GROUP BY 1, 2 ORDER BY 1, 2
`) as any[];
console.log("\n── by type ──");
for (const r of byType)
  console.log(`  ${r.t.padEnd(18)} ${r.status.padEnd(10)} n=${String(r.n).padEnd(3)} ₹${r.value}`);

// What Recent Sales now shows for the last 7 days, through the same filter
// the reports use.
const recent = (await pgClient`
  SELECT gp_no, sale_date::text AS d, customer_type::text AS t,
         grand_total::numeric AS total, payment_mode::text AS mode, status
    FROM direct_sales
   WHERE sale_date >= (now() AT TIME ZONE 'Asia/Kolkata')::date - 30
   ORDER BY created_at DESC
`) as any[];
console.log(`\n── sales in the last 30 days (${recent.length}) ──`);
for (const r of recent)
  console.log(`  ${(r.gp_no ?? "-").padEnd(9)} ${r.d} ${r.t.padEnd(17)} ₹${String(r.total).padEnd(9)} ${r.mode.padEnd(14)} ${r.status}`);

// Revenue as the reports now compute it (status filter applied) vs. raw.
const [rev] = (await pgClient`
  SELECT COALESCE(SUM(grand_total) FILTER (WHERE status = 'confirmed'), 0)::numeric AS "booked",
         COALESCE(SUM(grand_total), 0)::numeric AS "raw"
    FROM direct_sales
`) as any[];
console.log("\n── revenue the reports book ──");
console.log(`  with status filter: ₹${rev.booked}`);
console.log(`  without filter    : ₹${rev.raw}`);
console.log(
  rev.booked === rev.raw
    ? "  ✓ identical — the new filter changed nobody's numbers"
    : "  ⚠ they differ — something is cancelled"
);

const [inv] = (await pgClient`
  SELECT count(*)::int AS n FROM invoices i
   WHERE EXISTS (SELECT 1 FROM direct_sales d WHERE d.id = i.order_id)
`) as any[];
console.log(`\ndirect-sale invoices minted so far: ${inv.n} (grows as bill #s are clicked)`);

await pgClient.end();
