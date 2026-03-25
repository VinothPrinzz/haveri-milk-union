import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  integer,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// ── Categories ──
// Milk, Curd, Butter, Ghee, Paneer, Flavoured, Beverages, Sweets
export const categories = pgTable("categories", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull().unique(),
  icon: text("icon"), // emoji or icon identifier for UI
  sortOrder: integer("sort_order").notNull().default(0),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }), // soft delete
});

// Relations defined in products.ts to avoid circular imports
