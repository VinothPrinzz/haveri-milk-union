// Applies migration 0069 over the DIRECT connection (:5432), as ONE
// transaction: either every money column widens or none does.
//
// Deliberately not the migration runner — the _migrations table on prod is
// stale and running it would try to replay history.
import postgres from "postgres";
import { readFileSync } from "node:fs";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

const direct = process.env.DATABASE_URL;
if (!direct) throw new Error("DATABASE_URL (direct, :5432) not set");

const sql = postgres(direct, { prepare: false, max: 1, connect_timeout: 15 });

function statements(file: string): string[] {
  const stripped = file
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n");
  return stripped
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function main() {
  const file = readFileSync(
    path.resolve(__dirname, "../../../packages/db/src/migrations/0069_money_three_decimals.sql"),
    "utf8"
  );
  const stmts = statements(file);
  console.log(`statements to run: ${stmts.length}`);

  const t0 = Date.now();
  await sql.begin(async (tx) => {
    // Fail fast instead of queueing behind a live indent and stalling the API.
    await tx.unsafe("SET LOCAL lock_timeout = '30s'");
    await tx.unsafe("SET LOCAL statement_timeout = '10min'");
    for (const [i, s] of stmts.entries()) {
      const label = /ALTER\s+TABLE\s+(\w+)/i.exec(s)?.[1] ?? s.slice(0, 40);
      const st = Date.now();
      await tx.unsafe(s);
      console.log(`  [${i + 1}/${stmts.length}] ${label.padEnd(24)} ${Date.now() - st}ms`);
    }
  });
  console.log(`\nCOMMITTED in ${Date.now() - t0}ms`);

  // Post-check: nothing money-shaped may remain at scale 2.
  const left = await sql<{ t: string; c: string; p: number }[]>`
    SELECT c.table_name AS t, c.column_name AS c, c.numeric_precision::int AS p
      FROM information_schema.columns c
      JOIN information_schema.tables tb
        ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
     WHERE c.table_schema = 'public' AND tb.table_type = 'BASE TABLE'
       AND c.data_type = 'numeric' AND c.numeric_scale = 2
       AND c.column_name NOT IN
         ('gst_percent','subsidy_percent','old_gst_percent','new_gst_percent',
          'pack_size','total_km_per_day')
     ORDER BY 1, 2
  `;
  console.log(`money columns still at scale 2: ${left.length}`);
  left.forEach((r) => console.log(`   ${r.t}.${r.c}`));

  const [n3] = await sql`
    SELECT COUNT(*)::int AS n FROM information_schema.columns c
      JOIN information_schema.tables tb
        ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
     WHERE c.table_schema = 'public' AND tb.table_type = 'BASE TABLE'
       AND c.data_type = 'numeric' AND c.numeric_scale = 3
  `;
  console.log(`numeric(_,3) columns now (incl. orders partitions): ${n3!.n}`);

  await sql.end();
}

main().catch(async (e) => {
  console.error("\nFAILED — transaction rolled back, schema unchanged.");
  console.error(e);
  await sql.end().catch(() => {});
  process.exit(1);
});
