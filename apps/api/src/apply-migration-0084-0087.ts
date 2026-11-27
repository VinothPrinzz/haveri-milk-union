// Applies, in order:
//   0084_route_contractor_history.sql     route ↔ contractor history, trigger,
//                                         route_contractor_on(), DTC bill periods
//   0085_order_modifications.sql          modify log (dealer statement), backfill
//   0086_admin_notifications_and_demand.sql  staff bell + product demand
//   0087_supplier_ledger.sql              supplier payments / notes
//
// See apply-migration-0063.ts for why the repo migration runner is never
// pointed at prod (the _migrations table is stale there).
//
// All four are idempotent; each runs in its own transaction, so a failure
// stops at that file and leaves the earlier ones applied.
//
// Apply BEFORE deploying the API: the route sheet, dispatch sheet, sales
// reports and DTC bills now call route_contractor_on() and read
// dtc_bills.period_from; the new endpoints read the new tables. Deploy the
// worker after it too (materialize-drafts skips deleted drafts).
//
// USAGE (from apps/api):  npx tsx src/apply-migration-0084-0087.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pgClient } from "./lib/db.js";

const here = dirname(fileURLToPath(import.meta.url));
const FILES = [
  "0084_route_contractor_history.sql",
  "0085_order_modifications.sql",
  "0086_admin_notifications_and_demand.sql",
  "0087_supplier_ledger.sql",
];

async function main() {
  for (const f of FILES) {
    const body = readFileSync(join(here, "../../../packages/db/src/migrations", f), "utf8");
    await pgClient.begin(async (_tx) => {
      const tx = _tx as unknown as typeof pgClient;
      await tx.unsafe(body);
    });
    console.log(`${f} applied`);
  }

  const [c] = (await pgClient`
    SELECT
      (SELECT count(*)::int FROM routes) AS routes,
      (SELECT count(DISTINCT route_id)::int FROM route_contractor_history) AS routes_with_history,
      (SELECT count(*)::int FROM pg_proc WHERE proname = 'route_contractor_on') AS fn,
      (SELECT count(*)::int FROM pg_trigger WHERE tgname LIKE 'route_contractor_history_%') AS triggers,
      (SELECT count(*)::int FROM dtc_bills WHERE period_from IS NULL) AS bills_without_period,
      (SELECT count(*)::int FROM order_modifications) AS modifications,
      (SELECT count(*)::int FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('admin_notifications', 'admin_notification_reads',
                             'product_demand_requests', 'supplier_ledger_entries')) AS new_tables
  `) as any[];
  console.log(`  routes: ${c.routes}, with contractor history: ${c.routes_with_history} (expect equal)`);
  console.log(`  route_contractor_on(): ${c.fn} (expect 1), history triggers: ${c.triggers} (expect 2)`);
  console.log(`  DTC bills without a period: ${c.bills_without_period} (expect 0)`);
  console.log(`  order modifications (backfilled from ledger): ${c.modifications}`);
  console.log(`  new tables present: ${c.new_tables} (expect 4)`);

  await pgClient.end();
}

main().catch(async (e) => {
  console.error(e);
  await pgClient.end();
  process.exit(1);
});
