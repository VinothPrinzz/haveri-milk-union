// ═══════════════════════════════════════════════════════════════════════
// diag-fix-standing-indents-on-deleted-routes.ts — WRITES (one UPDATE).
//
// A standing indent is keyed per (dealer, route, product). Deleting a route
// used to leave its templates active, so the nightly job kept raising a daily
// draft indent on a route that no longer exists and can never be loaded —
// A B PARANDEKAR (A4) was doing exactly that on "HAVERI NIGHT 2 (A B P)
// ROUTE", ₹446.60 every morning since 2026-08-13.
//
// DELETE /api/v1/routes/:id now deactivates them at delete time; this clears
// the ones already in the data. Templates on live routes are untouched, and
// the rows are deactivated (active = false), never deleted.
//
// USAGE (from apps/api):  npx tsx src/diag-fix-standing-indents-on-deleted-routes.ts [--apply]
// ═══════════════════════════════════════════════════════════════════════

import { pgClient } from "./lib/db.js";

const apply = process.argv.includes("--apply");

async function main() {
  const before = await pgClient`
    SELECT d.code AS dealer_code, d.name AS dealer_name, r.name AS route_name,
           to_char(r.deleted_at, 'YYYY-MM-DD') AS route_deleted,
           count(*)::int AS active_lines,
           SUM(si.default_qty)::int AS daily_qty
    FROM dealer_standing_indents si
    JOIN dealers d ON d.id = si.dealer_id
    JOIN routes r  ON r.id = si.route_id
    WHERE r.deleted_at IS NOT NULL AND si.active = true
    GROUP BY 1, 2, 3, 4
    ORDER BY 1
  `;

  if (before.length === 0) {
    console.log("No active standing indent lines on a deleted route — nothing to do.");
    await pgClient.end();
    return;
  }

  console.log("Active standing indent lines sitting on a DELETED route:");
  for (const r of before as any[]) {
    console.log(
      `  ${String(r.dealer_code).padEnd(8)} ${String(r.dealer_name).padEnd(30)}` +
        ` route=${r.route_name} (deleted ${r.route_deleted})  lines=${r.active_lines} qty/day=${r.daily_qty}`,
    );
  }

  if (!apply) {
    console.log("\nDry run. Re-run with --apply to deactivate these lines.");
    await pgClient.end();
    return;
  }

  const updated = await pgClient`
    UPDATE dealer_standing_indents si
    SET active = false, updated_at = now()
    FROM routes r
    WHERE r.id = si.route_id
      AND r.deleted_at IS NOT NULL
      AND si.active = true
    RETURNING si.id
  `;
  console.log(`\nDeactivated ${updated.length} line(s).`);

  const [left] = await pgClient`
    SELECT count(*)::int AS n
    FROM dealer_standing_indents si
    JOIN routes r ON r.id = si.route_id
    WHERE r.deleted_at IS NOT NULL AND si.active = true
  `;
  console.log(`Active lines left on deleted routes: ${(left as any).n}`);

  await pgClient.end();
}

main().catch(async (e) => {
  console.error(e);
  await pgClient.end();
  process.exit(1);
});
