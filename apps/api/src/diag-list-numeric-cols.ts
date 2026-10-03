// Read-only: every numeric column with its scale, so non-money ones
// (percentages, weights, distances, counts) can be excluded from the
// rate/amount verifier instead of showing up as false failures.
import { pgClient } from "./lib/db.js";

async function main() {
  const cols = await pgClient<{ t: string; c: string; p: number; s: number }[]>`
    SELECT c.table_name AS t, c.column_name AS c,
           c.numeric_precision::int AS p, c.numeric_scale::int AS s
      FROM information_schema.columns c
      JOIN information_schema.tables tb
        ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
     WHERE c.table_schema = 'public' AND tb.table_type = 'BASE TABLE'
       AND c.data_type = 'numeric'
       AND c.table_name NOT LIKE 'orders_%'
     ORDER BY c.numeric_scale, c.table_name, c.column_name
  `;
  let last = -1;
  for (const c of cols) {
    if (c.s !== last) { console.log(`\n── scale ${c.s} ──`); last = c.s; }
    console.log(`   ${c.t}.${c.c}  numeric(${c.p},${c.s})`);
  }
  console.log(`\ntotal: ${cols.length}`);
  await pgClient.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
