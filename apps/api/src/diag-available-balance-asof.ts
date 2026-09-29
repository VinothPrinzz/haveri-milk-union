// Read-only: the Finance -> Available Balances "TOTAL AVAILABLE" tile, for one
// or more as-on dates. Replays the DEPLOYED summary query verbatim, so the
// numbers are what the screen shows (ROUTE = All).
//
// A month's OPENING balance is the tile as-on the LAST DAY OF THE PREVIOUS
// MONTH; its CLOSING is the tile as-on its own last day.
//
//   npx tsx apps/api/src/diag-available-balance-asof.ts 2026-06-30 2026-07-31 2026-08-31
import { pgClient } from "./lib/db.js";
const n = (x: unknown) => Number(x ?? 0);

async function tile(asOf: string) {
  const [r] = await pgClient`
    WITH dealer_balance AS (
      SELECT (
        COALESCE(d.opening_balance, 0)
        + COALESCE((
            SELECT SUM(CASE WHEN dl.type = 'credit' THEN dl.amount
                            WHEN dl.type = 'debit'  THEN -dl.amount END)
              FROM dealer_ledger dl
             WHERE dl.dealer_id = d.id
               AND COALESCE(dl.voucher_type, '') <> 'Opening'
               AND COALESCE(dl.voucher_date,
                            (dl.created_at AT TIME ZONE 'Asia/Kolkata')::date) <= ${asOf}::date
          ), 0)
      )::numeric AS closing_balance
      FROM dealers d
      WHERE (d.deleted_at IS NULL
             OR (d.deleted_at AT TIME ZONE 'Asia/Kolkata')::date > ${asOf}::date)
        AND (d.created_at AT TIME ZONE 'Asia/Kolkata')::date <= ${asOf}::date
        AND NOT EXISTS (SELECT 1 FROM routes demo_rt
                         WHERE demo_rt.code = 'DEMO' AND demo_rt.id = d.route_id)
    )
    SELECT COALESCE(SUM(GREATEST(0,  closing_balance)), 0)::float8 AS "totalAvailable",
           COALESCE(SUM(GREATEST(0, -closing_balance)), 0)::float8 AS "totalExposure",
           COUNT(*) FILTER (WHERE closing_balance >  0)::int AS funded,
           COUNT(*) FILTER (WHERE closing_balance <= 0)::int AS empty
      FROM dealer_balance`;
  return r as any;
}

async function main() {
  const dates = process.argv.slice(2);
  if (!dates.length) { console.log("usage: ... <YYYY-MM-DD> [more dates]"); await pgClient.end(); return; }
  console.log("\nAS ON        TOTAL AVAILABLE   FUNDED  EMPTY      (owed to union)");
  for (const d of dates) {
    const r = await tile(d);
    console.log(
      `${d}   ${n(r.totalAvailable).toFixed(2).padStart(14)}   ${String(r.funded).padStart(4)}   ${String(r.empty).padStart(4)}   ${n(r.totalExposure).toFixed(2).padStart(14)}`
    );
  }
  console.log();
  await pgClient.end();
}
main().catch(async (e) => { console.error(e); await pgClient.end(); process.exit(1); });
