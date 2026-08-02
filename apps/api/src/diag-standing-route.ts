// Read-only: inspect per-route standing-indent state.
import { pgClient } from "./lib/db.js";

async function main() {
  // 1. Does route_id exist on the table?
  const cols = await pgClient`
    SELECT column_name FROM information_schema.columns
     WHERE table_name = 'dealer_standing_indents' ORDER BY ordinal_position
  `;
  console.log("columns:", cols.map((c: any) => c.column_name).join(", "));

  // 2. Unique indexes on the table.
  const idx = await pgClient`
    SELECT indexname, indexdef FROM pg_indexes
     WHERE tablename = 'dealer_standing_indents'
  `;
  console.log("\nindexes:");
  for (const i of idx as any[]) console.log(`  ${i.indexname}: ${i.indexdef}`);

  // 3. Dealers assigned to 2+ routes.
  const multi = await pgClient`
    SELECT dr.dealer_id::text AS dealer_id, d.code, d.name,
           count(*)::int AS route_count,
           array_agg(dr.route_id::text) AS routes
      FROM dealer_routes dr
      JOIN dealers d ON d.id = dr.dealer_id AND d.deleted_at IS NULL
     GROUP BY dr.dealer_id, d.code, d.name
    HAVING count(*) > 1
     ORDER BY route_count DESC
     LIMIT 5
  `;
  console.log(`\n${multi.length} dealer(s) on 2+ routes (showing up to 5):`);
  for (const m of multi as any[]) {
    console.log(`\n  ${m.code ?? "?"} ${m.name} (${m.dealer_id.slice(0, 8)}) — ${m.route_count} routes`);
    // standing indents grouped by route_id for this dealer
    const rows = await pgClient`
      SELECT COALESCE(route_id::text, 'NULL') AS route_id,
             count(*)::int AS lines,
             sum(CASE WHEN active AND default_qty > 0 THEN 1 ELSE 0 END)::int AS active_lines
        FROM dealer_standing_indents
       WHERE dealer_id = ${m.dealer_id}::uuid
       GROUP BY route_id
       ORDER BY route_id
    `;
    if (rows.length === 0) console.log("      (no standing-indent rows)");
    for (const r of rows as any[]) {
      console.log(`      route ${String(r.route_id).slice(0, 8)}: ${r.lines} lines (${r.active_lines} active)`);
    }
  }
  await pgClient.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
