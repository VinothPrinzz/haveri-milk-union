import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { userRoleEnum } from "./enums.js";
import { zones } from "./zones.js";

// ── Admin ERP Users ──
// Roles: super_admin, manager, dispatch_officer, accountant, call_desk
// zone_id null = access to all zones
export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: userRoleEnum("role").notNull(),
  zoneId: uuid("zone_id").references(() => zones.id, { onDelete: "set null" }), // null = all zones
  phone: text("phone"),
  active: boolean("active").notNull().default(true),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }), // soft delete
});

// ── Admin Sessions ──
// Server-side sessions (NOT JWT). Must be revocable — Super Admin can kill compromised sessions.
export const adminSessions = pgTable("admin_sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(), // session token stored in httpOnly cookie
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Relations ──
export const usersRelations = relations(users, ({ one, many }) => ({
  zone: one(zones, {
    fields: [users.zoneId],
    references: [zones.id],
  }),
  sessions: many(adminSessions),
}));

export const adminSessionsRelations = relations(adminSessions, ({ one }) => ({
  user: one(users, {
    fields: [adminSessions.userId],
    references: [users.id],
  }),
}));
