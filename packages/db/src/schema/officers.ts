// ═══════════════════════════════════════════════════════════════════════
// Officers — field sales officers assigned to talukas (zones).
//
// Distinct from orders.officer_id / direct_sales.officer_id, which record
// the staff *user* that processed a sale. A taluka (zone) references one
// officer via zones.officer_id; one officer can cover multiple talukas.
// ═══════════════════════════════════════════════════════════════════════

import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { zones } from "./zones.js";

export const officers = pgTable("officers", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull().unique(),
  phone: text("phone"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const officersRelations = relations(officers, ({ many }) => ({
  zones: many(zones),
}));
