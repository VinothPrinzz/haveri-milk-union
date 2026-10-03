// ═══════════════════════════════════════════════════════════════════════
// diag-explain-changed-queries.ts — PARSE/PLAN CHECK (executes nothing).
//
// Pulls every pgClient`...` SELECT/WITH template literal out of the route
// files touched by the employee-indent change, substitutes NULL for each
// ${...} binding, and runs EXPLAIN on it. EXPLAIN plans but never executes,
// so this is read-only — and it is the only thing that actually proves a
// UNION's branches agree on column count and type, which TypeScript cannot
// see.
//
// Substituting NULL is sound for this purpose: every binding here sits in a
// `${x}::type IS NULL OR ...` guard, an ANY(...) array cast, or LIMIT/OFFSET
// (where NULL is legal and means "no limit"/"no offset").
//
// USAGE (from apps/api):  npx tsx src/diag-explain-changed-queries.ts
// ═══════════════════════════════════════════════════════════════════════

import { readFileSync } from "node:fs";
import { pgClient } from "./lib/db.js";

import { readdirSync } from "node:fs";

// Every query-bearing directory in the API and the worker.
const DIRS = [
  { url: new URL("./routes/", import.meta.url),                 prefix: "src/routes" },
  { url: new URL("./lib/", import.meta.url),                    prefix: "src/lib" },
  { url: new URL("../../worker/src/jobs/", import.meta.url),    prefix: "../worker/src/jobs" },
  { url: new URL("../../worker/src/lib/", import.meta.url),     prefix: "../worker/src/lib" },
];
const FILES = DIRS.flatMap(({ url, prefix }) => {
  try {
    return readdirSync(url).filter(f => f.endsWith(".ts")).map(f => `${prefix}/${f}`);
  } catch { return []; }
});

// The API tags queries `pgClient`...``; inside a transaction it's `tx`...``,
// and the worker names its client `sql`. All three are the same postgres.js
// tag, so all three have to be swept.
const MARKERS = ["pgClient`", "sql`", "tx`"];

/** Every tagged query literal in a file, with its 1-based start line. */
function extractQueries(src: string, marker: string): Array<{ line: number; sql: string }> {
  const out: Array<{ line: number; sql: string }> = [];
  let idx = src.indexOf(marker);
  while (idx !== -1) {
    const start = idx + marker.length;
    let end = start;
    // Track ${...} depth: a binding may itself hold a template literal
    // (dealers.ts has ${`%${q.name}%`}), whose backticks must NOT be read as
    // the end of the query.
    let depth = 0;
    while (end < src.length) {
      if (src[end] === "\\") { end += 2; continue; }
      if (src[end] === "$" && src[end + 1] === "{") { depth += 1; end += 2; continue; }
      if (src[end] === "}" && depth > 0) { depth -= 1; end += 1; continue; }
      if (src[end] === "`" && depth === 0) break;
      end += 1;
    }
    out.push({
      line: src.slice(0, idx).split("\n").length,
      sql: src.slice(start, end),
    });
    idx = src.indexOf(marker, end);
  }
  return out;
}

/**
 * Replace every `${...}` binding with NULL, counting braces so a nested
 * template literal in the expression (e.g. ${`%${q.search}%`} in dealers.ts)
 * is consumed whole instead of terminating at its inner brace.
 */
function stripBindings(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    if (sql[i] === "$" && sql[i + 1] === "{") {
      let depth = 1;
      let j = i + 2;
      while (j < sql.length && depth > 0) {
        if (sql[j] === "{") depth += 1;
        else if (sql[j] === "}") depth -= 1;
        j += 1;
      }
      out += "NULL";
      i = j;
      continue;
    }
    out += sql[i];
    i += 1;
  }
  return out;
}

async function main() {
  let checked = 0;
  let failed = 0;

  for (const file of FILES) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    const found = MARKERS.flatMap(m => extractQueries(src, m));
    // Same literal can match two markers (pgClient` contains no sql`, but a
    // `sql`` inside `pgClient.begin` does) — dedupe on start line + text.
    const seen = new Set<string>();
    for (const { line, sql } of found) {
      if (seen.has(`${line}:${sql}`)) continue;
      seen.add(`${line}:${sql}`);
      // Bindings become NULL; tx`...` blocks and writes are skipped.
      const plain = stripBindings(sql).trim();
      const head = plain.replace(/^--.*$/gm, "").trim().slice(0, 6).toUpperCase();
      if (!head.startsWith("SELECT") && !head.startsWith("WITH")) continue;

      checked += 1;
      try {
        await pgClient.unsafe(`EXPLAIN ${plain}`);
      } catch (e: any) {
        failed += 1;
        console.log(`\n✗ ${file}:${line}`);
        console.log(`  ${e.message}`);
        if (e.position) {
          const pos = parseInt(e.position, 10);
          console.log(`  near: …${plain.slice(Math.max(0, pos - 90), pos + 60).replace(/\s+/g, " ")}…`);
        }
      }
    }
  }

  console.log(`\n${checked - failed}/${checked} queries planned cleanly.`);
  await pgClient.end();
  if (failed) process.exit(1);
}

main().catch(async (e) => { console.error(e); await pgClient.end(); process.exit(1); });
