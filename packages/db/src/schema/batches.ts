import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { batchStatusEnum } from "./enums.js";
import { routes } from "./distribution.js";

// ── Batches (Distribution Batches) ──
// Production/distribution schedule batches: "Morning Batch", "Afternoon Batch", etc.
// NOT manufacturing batches — these are delivery schedule batches.
export const batches = pgTable("batches", {
  id: uuid("id").defaultRandom().primaryKey(),
  batchNumber: text("batch_number").notNull().unique(), // e.g. "BT01", "BT02"
  name: text("name").notNull(),                         // e.g. "Morning Batch"
  whichBatch: text("which_batch").notNull(),             // "Morning", "Afternoon", "Evening", "Night"
  timing: text("timing"),                                // "5:00 AM - 8:00 AM"
  status: batchStatusEnum("status").notNull().default("active"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }), // soft delete
}, (table) => [
  index("idx_batches_status").on(table.status),
]);

// ── Batch Routes (many-to-many: batches ↔ routes) ──
// A batch can serve multiple routes; a route can be served by multiple batches.
export const batchRoutes = pgTable("batch_routes", {
  id: uuid("id").defaultRandom().primaryKey(),
  batchId: uuid("batch_id")
    .notNull()
    .references(() => batches.id, { onDelete: "cascade" }),
  routeId: uuid("route_id")
    .notNull()
    .references(() => routes.id, { onDelete: "cascade" }),
}, (table) => [
  unique("uq_batch_routes").on(table.batchId, table.routeId),
  index("idx_batch_routes_batch").on(table.batchId),
  index("idx_batch_routes_route").on(table.routeId),
]);

// ── Relations ──
export const batchesRelations = relations(batches, ({ many }) => ({
  batchRoutes: many(batchRoutes),
}));

export const batchRoutesRelations = relations(batchRoutes, ({ one }) => ({
  batch: one(batches, {
    fields: [batchRoutes.batchId],
    references: [batches.id],
  }),
  route: one(routes, {
    fields: [batchRoutes.routeId],
    references: [routes.id],
  }),
}));
