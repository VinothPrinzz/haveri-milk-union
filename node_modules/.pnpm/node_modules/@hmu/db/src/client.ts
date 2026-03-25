import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

// ── Connection ──
// Uses postgres.js — the fastest pure-JS Postgres driver.
// DATABASE_URL = direct connection (for migrations, single queries).
// DATABASE_URL_POOLED = Supabase pgBouncer pooled connection (for the API at runtime).
//
// In production, use the pooled URL for all API queries.
// Use the direct URL only for migrations and Drizzle Studio.

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({
  path: path.resolve(__dirname, "../../../.env"),
});

const connectionString = process.env.DATABASE_URL_POOLED || process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    "Missing DATABASE_URL or DATABASE_URL_POOLED environment variable. " +
      "Copy .env.example to .env and fill in your Supabase credentials."
  );
}

// Create the postgres.js connection
const client = postgres(connectionString, {
  // Supabase pgBouncer requires prepare: false in transaction pooling mode
  prepare: false,
  // Connection pool settings
  max: 10, // max connections in pool
  idle_timeout: 20, // close idle connections after 20s
  connect_timeout: 10, // fail if can't connect in 10s
});

// Create the Drizzle ORM instance with all schema relations loaded
export const db = drizzle(client, {
  schema,
  logger: process.env.NODE_ENV === "development",
});

// Export the raw postgres client for raw SQL when needed
// (e.g., the atomic wallet deduction query)
export { client as pgClient };

// Export types for use in other packages
export type Database = typeof db;
