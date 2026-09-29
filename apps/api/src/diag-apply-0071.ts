// Applies migration 0071 (direct_sales cancellation state) over the DIRECT
// connection (:5432) as ONE transaction. Prints the before/after shape so the
// run is auditable, and refuses if the column already exists with data that
// contradicts the new CHECK.
//
// USAGE (from apps/api):
//   npx tsx src/diag-apply-0071.ts            ← dry run (prints, rolls back)
//   npx tsx src/diag-apply-0071.ts --apply    ← commit
import postgres from "postgres";
import { readFileSync } from "node:fs";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

const APPLY = process.argv.includes("--apply");

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
  console.log(APPLY ? "MIGRATION 0071 — APPLY" : "MIGRATION 0071 — DRY RUN (rolls back)");
  console.log("──────────────────────────────────────────────");

  const before = await sql<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'direct_sales'
     ORDER BY ordinal_position
  `;
  console.log("direct_sales columns BEFORE:");
  console.log("  " + before.map((c) => c.column_name).join(", "));

  const countRows = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM direct_sales
  `;
  const saleCount = countRows[0]!.n;
  console.log(`\nexisting direct_sales rows: ${saleCount} (all become status='confirmed')`);

  const file = readFileSync(
    path.resolve(__dirname, "../../../packages/db/src/migrations/0071_direct_sales_cancellation.sql"),
    "utf8"
  );
  const stmts = statements(file);
  console.log(`\nstatements to run: ${stmts.length}`);

  const t0 = Date.now();
  let rolledBack = false;
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL lock_timeout = '30s'");
      await tx.unsafe("SET LOCAL statement_timeout = '5min'");

      for (const [i, s] of stmts.entries()) {
        const label =
          /ALTER\s+TABLE\s+(\w+)\s+(\w+)/i.exec(s)?.slice(1).join(" ") ??
          /CREATE\s+INDEX[^\s]*\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/i.exec(s)?.[1] ??
          s.slice(0, 40);
        const st = Date.now();
        await tx.unsafe(s);
        console.log(`  [${i + 1}/${stmts.length}] ${label.padEnd(34)} ${Date.now() - st}ms`);
      }

      // Verify inside the tx, before deciding to keep it.
      const [{ n: confirmed }] = (await tx.unsafe(
        `SELECT count(*)::int AS n FROM direct_sales WHERE status = 'confirmed'`
      )) as any[];
      console.log(`\n  in-tx check: ${confirmed}/${saleCount} rows are 'confirmed'`);
      if (confirmed !== saleCount) throw new Error("not every existing sale defaulted to 'confirmed'");

      if (!APPLY) {
        rolledBack = true;
        throw new Error("__DRY_RUN__");
      }
    });
  } catch (err: any) {
    if (err?.message === "__DRY_RUN__") {
      console.log(`\n— dry run — rolled back after ${Date.now() - t0}ms. Re-run with --apply to commit.`);
      await sql.end();
      return;
    }
    throw err;
  }

  console.log(`\nCOMMITTED in ${Date.now() - t0}ms`);

  const after = await sql<{ column_name: string; is_nullable: string; column_default: string | null }[]>`
    SELECT column_name, is_nullable, column_default
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'direct_sales'
       AND column_name IN ('status', 'cancelled_at', 'cancellation_reason', 'cancelled_by')
     ORDER BY column_name
  `;
  console.log("\nnew columns:");
  for (const c of after)
    console.log(`  ${c.column_name.padEnd(20)} nullable=${c.is_nullable} default=${c.column_default ?? "-"}`);

  const cons = await sql<{ conname: string; def: string }[]>`
    SELECT conname, pg_get_constraintdef(oid) AS def
      FROM pg_constraint
     WHERE conrelid = 'direct_sales'::regclass AND conname LIKE '%cancel%' OR
           (conrelid = 'direct_sales'::regclass AND conname LIKE '%status%')
     ORDER BY conname
  `;
  console.log("\nconstraints:");
  for (const c of cons) console.log(`  ${c.conname}: ${c.def}`);

  await sql.end();
}

main().catch(async (e) => {
  console.error("\nFAILED — transaction rolled back, schema unchanged.");
  console.error(e.message ?? e);
  await sql.end().catch(() => {});
  process.exit(1);
});
