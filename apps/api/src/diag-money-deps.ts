// Read-only: anything that would silently re-round money back to 2dp after
// the columns widen - trigger functions, defaults, check constraints,
// generated columns, and materialized views.
import { pgClient } from "./lib/db.js";

async function main() {
  const fns = await pgClient<{ name: string; src: string }[]>`
    SELECT p.proname AS name, pg_get_functiondef(p.oid) AS src
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
  `;
  console.log(`-- functions in public: ${fns.length}`);
  for (const f of fns) {
    const hits = (f.src.match(/round\s*\([^)]*,\s*2\s*\)|numeric\s*\(\s*\d+\s*,\s*2\s*\)/gi) ?? []);
    if (hits.length) console.log(`   ${f.name}: ${[...new Set(hits)].join(", ")}`);
  }

  const trg = await pgClient<{ tbl: string; name: string; fn: string }[]>`
    SELECT c.relname AS tbl, t.tgname AS name, p.proname AS fn
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_proc p ON p.oid = t.tgfoid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE NOT t.tgisinternal AND n.nspname = 'public'
     ORDER BY c.relname
  `;
  console.log(`\n-- triggers: ${trg.length}`);
  for (const t of trg) console.log(`   ${t.tbl}.${t.name} -> ${t.fn}()`);

  const gen = await pgClient<{ tbl: string; col: string; expr: string }[]>`
    SELECT c.relname AS tbl, a.attname AS col,
           pg_get_expr(d.adbin, d.adrelid) AS expr
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE n.nspname = 'public' AND a.attgenerated <> ''
     ORDER BY c.relname
  `;
  console.log(`\n-- generated columns: ${gen.length}`);
  for (const g of gen) console.log(`   ${g.tbl}.${g.col} = ${g.expr}`);

  const mv = await pgClient<{ matviewname: string }[]>`
    SELECT matviewname FROM pg_matviews WHERE schemaname = 'public'
  `;
  console.log(`\n-- materialized views: ${mv.map((m) => m.matviewname).join(", ") || "(none)"}`);

  await pgClient.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
