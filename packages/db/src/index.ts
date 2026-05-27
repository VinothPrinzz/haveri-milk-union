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

// ▼▼▼ DUAL-DB (Temporarily Commented Out — db-manager.ts not yet in repo) ▼▼▼
// export { getDbManager, DatabaseManager } from "./db-manager.js";
// export type {
//   FailoverEvent,
//   DbRole,
//   DbStatus,
//   DbManagerConfig,
//   ConnectionStatus,
// } from "./db-manager.js";
// ▲▲▲ DUAL-DB ▲▲▲
