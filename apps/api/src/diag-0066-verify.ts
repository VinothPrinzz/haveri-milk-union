// ═══════════════════════════════════════════════════════════════════════
// diag-0066-verify.ts — read-only look at what the ADHOC bucket's derived
// dispatch status will report, for a given date (default: today IST).
//
// Runs the same open/done split the dispatch-sheet query uses, so the
// number here is exactly what the card's pill will show.
//
// USAGE (from apps/api):  npx tsx src/diag-0066-verify.ts [YYYY-MM-DD]
// ═══════════════════════════════════════════════════════════════════════
import { pgClient } from "./lib/db.js";

const date = process.argv[2]
  ?? new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

async function main() {
  const [totals] = (await pgClient`
    SELECT count(*)::int                                      AS all_sales,
           count(*) FILTER (WHERE dispatched_at IS NOT NULL)::int AS stamped
      FROM direct_sales
  `) as any[];
  console.log(`direct_sales overall: ${totals.all_sales} rows, ${totals.stamped} with dispatched_at`);

  const [state] = (await pgClient`
    SELECT
      COUNT(*) FILTER (WHERE NOT done)::int AS open_count,
      COUNT(*) FILTER (WHERE done)::int     AS done_count
    FROM (
      SELECT ds.dispatched_at IS NOT NULL AS done
        FROM direct_sales ds
       WHERE ds.sale_date = ${date}::date
         AND ds.route_id IS NULL
         AND ds.customer_type IN ('cash', 'vip_sample', 'employee_subsidy')
      UNION ALL
      SELECT eo.status::text = 'dispatched'
        FROM employee_orders eo
       WHERE eo.delivery_date = ${date}::date
         AND eo.route_id IS NULL
         AND eo.status::text IN ('confirmed', 'dispatched')
    ) s
  `) as any[];

  const pill = state.open_count === 0 && state.done_count > 0 ? "dispatched" : "pending";
  console.log(`\nADHOC bucket on ${date}: open=${state.open_count} done=${state.done_count}`);
  console.log(`  status pill would read: ${pill}`);
  if (state.open_count === 0 && state.done_count === 0) {
    console.log("  (nothing in the bucket that day, so no card is drawn at all)");
  }

  const rows = (await pgClient`
    SELECT ds.customer_type::text AS source,
           count(*)::int          AS sales,
           count(*) FILTER (WHERE ds.dispatched_at IS NOT NULL)::int AS dispatched
      FROM direct_sales ds
     WHERE ds.sale_date = ${date}::date
       AND ds.route_id IS NULL
       AND ds.customer_type IN ('cash', 'vip_sample', 'employee_subsidy')
     GROUP BY ds.customer_type
     ORDER BY 1
  `) as any[];
  if (rows.length) {
    console.log("\n  route-less adhoc sales that day:");
    for (const r of rows) console.log(`    ${r.source}: ${r.sales} sales, ${r.dispatched} dispatched`);
  }

  await pgClient.end();
}

main().catch(async (e) => { console.error(e); await pgClient.end(); process.exit(1); });
