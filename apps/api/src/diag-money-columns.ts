// Read-only: enumerate every numeric column with scale 2 (money) in the
// live schema, so the 2dp -> 3dp widening migration covers all of them.
import { pgClient } from "./lib/db.js";

async function main() {
  const rows = await pgClient<
    { table_name: string; column_name: string; precision: number; scale: number; is_generated: string; default_expr: string | null }[]
  >`
    SELECT c.table_name,
           c.column_name,
           c.numeric_precision::int AS precision,
           c.numeric_scale::int     AS scale,
           c.is_generated,
           c.column_default         AS default_expr
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.table_schema = 'public'
       AND t.table_type = 'BASE TABLE'
       AND c.data_type = 'numeric'
       AND c.numeric_scale = 2
     ORDER BY c.table_name, c.ordinal_position
  `;

  console.log(`numeric(_,2) columns: ${rows.length}\n`);
  let last = "";
  for (const r of rows) {
    if (r.table_name !== last) {
      console.log(`\n-- ${r.table_name}`);
      last = r.table_name;
    }
    const gen = r.is_generated === "ALWAYS" ? "  [GENERATED]" : "";
    const def = r.default_expr ? `  default ${r.default_expr}` : "";
    console.log(`   ${r.column_name.padEnd(28)} numeric(${r.precision},${r.scale})${gen}${def}`);
  }

  // Views that select these columns will need rebuilding if the type changes.
  const views = await pgClient<{ viewname: string }[]>`
    SELECT viewname FROM pg_views WHERE schemaname = 'public' ORDER BY viewname
  `;
  console.log(`\n\nviews in public: ${views.map((v) => v.viewname).join(", ") || "(none)"}`);

  // Partitioned parents need the ALTER applied once (it cascades to partitions).
  const parts = await pgClient<{ parent: string; n: number }[]>`
    SELECT c.relname AS parent, COUNT(i.inhrelid)::int AS n
      FROM pg_class c
      JOIN pg_inherits i ON i.inhparent = c.oid
     WHERE c.relkind = 'p'
     GROUP BY c.relname ORDER BY c.relname
  `;
  console.log(`partitioned tables: ${parts.map((p) => `${p.parent}(${p.n})`).join(", ") || "(none)"}`);

  await pgClient.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
