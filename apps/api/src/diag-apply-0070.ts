// Applies migration 0070 over the DIRECT connection (:5432) as ONE
// transaction. Re-checks losslessness INSIDE the transaction first, so a
// 3dp amount appearing between the earlier check and now aborts the run
// instead of silently rounding real money.
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
  return file
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function main() {
  const file = readFileSync(
    path.resolve(__dirname, "../../../packages/db/src/migrations/0070_amounts_back_to_two_decimals.sql"),
    "utf8"
  );
  const stmts = statements(file);
  console.log(`statements to run: ${stmts.length}`);

  const t0 = Date.now();
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL lock_timeout = '30s'");
    await tx.unsafe("SET LOCAL statement_timeout = '10min'");

    // Guard: abort if any amount column already holds a 3rd decimal.
    const guard = await tx.unsafe(`
      SELECT c.table_name AS t, c.column_name AS c
        FROM information_schema.columns c
        JOIN information_schema.tables tb
          ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
       WHERE c.table_schema = 'public' AND tb.table_type = 'BASE TABLE'
         AND c.data_type = 'numeric' AND c.numeric_scale = 3
         AND c.table_name NOT LIKE 'orders_%'
    `);
    let rounded = 0;
    for (const g of guard as any[]) {
      // only the columns this migration narrows matter
      const narrows = stmts.some(
        (s) =>
          new RegExp(`ALTER\\s+TABLE\\s+${g.t}\\b`, "i").test(s) &&
          new RegExp(`ALTER\\s+COLUMN\\s+${g.c}\\b`, "i").test(s)
      );
      if (!narrows) continue;
      const [r] = await tx.unsafe(
        `SELECT COUNT(*)::int AS n FROM ${g.t} WHERE ${g.c} IS NOT NULL AND (${g.c} * 1000)::bigint % 10 <> 0`
      );
      if ((r as any).n > 0) {
        console.error(`   ABORT: ${g.t}.${g.c} has ${(r as any).n} rows with a 3rd decimal`);
        rounded += (r as any).n;
      }
    }
    if (rounded > 0) throw new Error(`${rounded} rows would be rounded — refusing to narrow`);

    for (const [i, s] of stmts.entries()) {
      const label = /ALTER\s+TABLE\s+(\w+)/i.exec(s)?.[1] ?? s.slice(0, 40);
      const st = Date.now();
      await tx.unsafe(s);
      console.log(`  [${i + 1}/${stmts.length}] ${label.padEnd(24)} ${Date.now() - st}ms`);
    }
  });
  console.log(`\nCOMMITTED in ${Date.now() - t0}ms`);

  const rates = await sql<{ t: string; c: string }[]>`
    SELECT c.table_name AS t, c.column_name AS c
      FROM information_schema.columns c
      JOIN information_schema.tables tb
        ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
     WHERE c.table_schema = 'public' AND tb.table_type = 'BASE TABLE'
       AND c.data_type = 'numeric' AND c.numeric_scale = 3
       AND c.table_name NOT LIKE 'orders_%'
     ORDER BY 1, 2
  `;
  console.log(`\nrate columns still at 3dp (${rates.length}):`);
  rates.forEach((r) => console.log(`   ${r.t}.${r.c}`));

  await sql.end();
}

main().catch(async (e) => {
  console.error("\nFAILED — transaction rolled back, schema unchanged.");
  console.error(e.message ?? e);
  await sql.end().catch(() => {});
  process.exit(1);
});
