import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  integer,
  numeric,
  date,
  time,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { dispatchStatusEnum } from "./enums.js";
import { zones } from "./zones.js";

// ── Routes ──
// Route master: name, zone, stops, distance, active.
// Phase 2: Added contractor_id FK to link routes to their default contractor.
export const routes = pgTable("routes", {
  id: uuid("id").defaultRandom().primaryKey(),
  code: text("code").notNull().unique(), // e.g. "R1", "R2"
  name: text("name").notNull(), // e.g. "Haveri City Route 1"
  zoneId: uuid("zone_id")
    .notNull()
    .references(() => zones.id, { onDelete: "restrict" }),
  stops: integer("stops").notNull().default(0),
  distanceKm: numeric("distance_km", { precision: 6, scale: 1 }),
  stopDetails: text("stop_details"), // JSONB stored as text for Drizzle compatibility (added in 0002)
  contractorId: uuid("contractor_id"), // Phase 2: FK to contractors (no inline ref to avoid circular import)
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }), // soft delete
});

// ── Vehicles ──
export const vehicles = pgTable("vehicles", {
  id: uuid("id").defaultRandom().primaryKey(),
  number: text("number").notNull().unique(), // e.g. "KA-25-AB-1234"
  type: text("type").notNull().default("truck"), // truck, van, mini-truck
  capacity: text("capacity"), // e.g. "500 crates", "2 ton"
  driverName: text("driver_name"),
  driverPhone: text("driver_phone"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }), // soft delete
});

// ── Route Assignments (daily dispatch) ──
export const routeAssignments = pgTable("route_assignments", {
  id: uuid("id").defaultRandom().primaryKey(),
  routeId: uuid("route_id")
    .notNull()
    .references(() => routes.id, { onDelete: "restrict" }),
  vehicleId: uuid("vehicle_id").references(() => vehicles.id, { onDelete: "set null" }),
  vehicleNumber: text("vehicle_number"), // convenience column added in 0002
  date: date("date").notNull(),
  driverName: text("driver_name"),
  driverPhone: text("driver_phone"),
  departureTime: time("departure_time"),
  actualDepartureTime: timestamp("actual_departure_time", { withTimezone: true }),
  dealerCount: integer("dealer_count").notNull().default(0),
  itemCount: integer("item_count").notNull().default(0),
  status: dispatchStatusEnum("status").notNull().default("pending"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_route_assignments_date").on(table.date),
  index("idx_route_assignments_route").on(table.routeId),
  index("idx_route_assignments_status").on(table.status),
]);

// ── Relations ──
// Note: contractor relation for routes is defined in contractors.ts to avoid circular imports.
// The relation from routes → zone is here.
export const routesRelations = relations(routes, ({ one, many }) => ({
  zone: one(zones, {
    fields: [routes.zoneId],
    references: [zones.id],
  }),
  assignments: many(routeAssignments),
}));

export const vehiclesRelations = relations(vehicles, ({ many }) => ({
  assignments: many(routeAssignments),
}));

export const routeAssignmentsRelations = relations(routeAssignments, ({ one }) => ({
  route: one(routes, {
    fields: [routeAssignments.routeId],
    references: [routes.id],
  }),
  vehicle: one(vehicles, {
    fields: [routeAssignments.vehicleId],
    references: [vehicles.id],
  }),
}));
