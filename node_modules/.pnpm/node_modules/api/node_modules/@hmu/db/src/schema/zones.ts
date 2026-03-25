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
// Per-zone ordering window. open_time, warning_time (amber countdown), close_time.
// Times stored as time-of-day. The API computes window state from these + current IST time.
export const timeWindows = pgTable("time_windows", {
  id: uuid("id").defaultRandom().primaryKey(),
  zoneId: uuid("zone_id")
    .notNull()
    .references(() => zones.id, { onDelete: "restrict" })
    .unique(), // one window config per zone
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
}));
