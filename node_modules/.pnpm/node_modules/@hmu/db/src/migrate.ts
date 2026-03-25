/**
 * Migration runner — applies hand-written SQL migration files.
 *
 * Usage: pnpm --filter @hmu/db migrate
 *
 * Why hand-written instead of Drizzle-generated?
 * The orders table is partitioned by month. Drizzle cannot generate:
 *   - PARTITION BY RANGE clauses
 *   - Individual partition DDL
 *   - Partial indexes (WHERE clause on index)
 *   - Helper functions for dynamic partition creation
 *   - Seed data
 *
 * This script reads SQL files from src/migrations/ in order and applies them.
 * It tracks which migrations have been applied in a _migrations table.
 */

import dotenv from "dotenv";
import path from "path";
import postgres from "postgres";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

dotenv.config({
  path: path.resolve(__dirname, "../../../.env"),
});

const MIGRATIONS_DIR = join(__dirname, "migrations");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("❌ Missing DATABASE_URL in .env");
  process.exit(1);
}

const sql = postgres(DATABASE_URL, { max: 1 });

async function migrate() {
  console.log("📦 Running migrations...\n");

  // Create migrations tracking table if it doesn't exist
  await sql`
    CREATE TABLE IF NOT EXISTS _migrations (
      id         serial PRIMARY KEY,
      name       text NOT NULL UNIQUE,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;

  // Get list of already-applied migrations
  const applied = await sql`SELECT name FROM _migrations ORDER BY name`;
  const appliedSet = new Set(applied.map((r) => r.name));

  // Read all .sql files from migrations directory
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  if (files.length === 0) {
    console.log("  No migration files found.");
    await sql.end();
    return;
  }

  let appliedCount = 0;

  for (const file of files) {
    if (appliedSet.has(file)) {
      console.log(`  ⏭️  ${file} (already applied)`);
      continue;
    }

    const filePath = join(MIGRATIONS_DIR, file);
    const sqlContent = readFileSync(filePath, "utf-8");

    console.log(`  ▶️  Applying ${file}...`);

    try {
      // Run the entire migration file as a single transaction
      await sql.begin(async (tx) => {
        await tx.unsafe(sqlContent);
        await tx`INSERT INTO _migrations (name) VALUES (${file})`;
      });

      console.log(`  ✅ ${file} applied successfully`);
      appliedCount++;
    } catch (err) {
      console.error(`  ❌ ${file} FAILED:`, err);
      await sql.end();
      process.exit(1);
    }
  }

  if (appliedCount === 0) {
    console.log("\n  All migrations already applied.");
  } else {
    console.log(`\n🎉 Applied ${appliedCount} migration(s)`);
  }

  await sql.end();
}

migrate().catch((err) => {
  console.error("❌ Migration runner failed:", err);
  process.exit(1);
});
