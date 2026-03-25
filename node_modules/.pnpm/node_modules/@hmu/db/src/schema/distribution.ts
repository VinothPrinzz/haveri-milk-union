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
export const routes = pgTable("routes", {
  id: uuid("id").defaultRandom().primaryKey(),
  code: text("code").notNull().unique(), // e.g. "R1", "R2"
  name: text("name").notNull(), // e.g. "Haveri Central", "Ranebennur Main"
  zoneId: uuid("zone_id")
    .notNull()
    .references(() => zones.id, { onDelete: "restrict" }),
  stops: integer("stops").notNull().default(0), // number of dealer stops
  distanceKm: numeric("distance_km", { precision: 6, scale: 1 }), // route distance
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }), // soft delete
});

// ── Vehicles ──
// Vehicle master for dispatch assignments.
export const vehicles = pgTable("vehicles", {
  id: uuid("id").defaultRandom().primaryKey(),
  number: text("number").notNull().unique(), // e.g. "KA-25-AB-1234"
  type: text("type").notNull().default("truck"), // truck, van, tempo
  capacity: text("capacity"), // e.g. "2 Ton"
  driverName: text("driver_name"),
  driverPhone: text("driver_phone"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

// ── Route Assignments ──
// Daily: route_id, vehicle_number, driver_name, departure_time, status.
// Created each day after the ordering window closes.
export const routeAssignments = pgTable("route_assignments", {
  id: uuid("id").defaultRandom().primaryKey(),
  routeId: uuid("route_id")
    .notNull()
    .references(() => routes.id, { onDelete: "restrict" }),
  vehicleId: uuid("vehicle_id")
    .references(() => vehicles.id, { onDelete: "set null" }),
  date: date("date").notNull(), // dispatch date
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
