import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  time,
  integer,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { routes } from "./distribution.js";

// ── Zones ──
// Haveri, Ranebennur, Savanur, Byadgi, Hirekerur, Hangal
// Each zone has its own ordering window times.
export const zones = pgTable("zones", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull().unique(),
  slug: text("slug").notNull().unique(), // e.g. "haveri", "ranebennur"
  icon: text("icon"), // emoji or icon identifier
  color: text("color"), // hex color for UI display (e.g. "#1448CC")
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Time Windows ──
// Ordering window keyed primarily by route_id (migration 0023).
// zone_id is kept for backward compat but is now nullable.
// The API computes window state from open_time / close_time + current IST time.
export const timeWindows = pgTable("time_windows", {
  id: uuid("id").defaultRandom().primaryKey(),
  // route_id is the primary key column going forward (unique per-route window)
  routeId: uuid("route_id").references(() => routes.id, { onDelete: "cascade" }),
  // zone_id kept nullable for legacy rows; new rows should use route_id
  zoneId: uuid("zone_id").references(() => zones.id, { onDelete: "restrict" }),
  openTime: time("open_time").notNull(), // e.g. "06:00"
  warningMinutes: integer("warning_minutes").notNull().default(20), // minutes before close to show amber
  closeTime: time("close_time").notNull(), // e.g. "08:00"
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Relations ──
export const zonesRelations = relations(zones, ({ one, many }) => ({
  timeWindow: one(timeWindows, {
    fields: [zones.id],
    references: [timeWindows.zoneId],
  }),
}));

export const timeWindowsRelations = relations(timeWindows, ({ one }) => ({
  zone: one(zones, {
    fields: [timeWindows.zoneId],
    references: [zones.id],
  }),
  route: one(routes, {
    fields: [timeWindows.routeId],
    references: [routes.id],
  }),
}));
