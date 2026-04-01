import postgres from "postgres";

const connectionString = process.env.DATABASE_URL_POOLED || process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("Missing DATABASE_URL environment variable for worker");
}

export const sql = postgres(connectionString, {
  prepare: false,
  max: 5,
  idle_timeout: 20,
});
