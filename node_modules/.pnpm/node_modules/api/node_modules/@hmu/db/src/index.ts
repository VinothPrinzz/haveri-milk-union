// ══════════════════════════════════════════════════════════════════
// @hmu/db — Package Entry Point
//
// Usage from other packages:
//   import { db } from "@hmu/db"           — database client
//   import { zones, dealers } from "@hmu/db/schema"  — schema tables
//   import { db } from "@hmu/db/client"    — explicit client import
// ══════════════════════════════════════════════════════════════════

export { db, pgClient } from "./client.js";
export type { Database } from "./client.js";

// Re-export all schema for convenience
export * from "./schema/index.js";
