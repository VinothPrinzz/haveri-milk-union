/**
 * Re-export the database client from @hmu/db for use in route handlers.
 *
 * The client uses DATABASE_URL_POOLED (Supabase pgBouncer) in production
 * for connection pooling, falling back to DATABASE_URL for development.
 */
export { db, pgClient } from "@hmu/db/client";
export type { Database } from "@hmu/db/client";
