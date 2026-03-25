import {
  pgTable,
  uuid,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

// ── System Settings ──
// Key-value store for organization settings.
// Grouped by category: organization, app_config, address, bank.
// This is a simple k/v approach — easier to extend without schema migration
// when the admin adds new settings fields.
export const systemSettings = pgTable("system_settings", {
  id: uuid("id").defaultRandom().primaryKey(),
  category: text("category").notNull(), // "organization" | "app_config" | "address" | "bank"
  key: text("key").notNull(),
  value: text("value").notNull(),
  updatedBy: uuid("updated_by"), // admin user who last changed this setting
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Notification Config ──
// Per-event notification toggle settings (push/sms/email per event type).
export const notificationConfig = pgTable("notification_config", {
  id: uuid("id").defaultRandom().primaryKey(),
  eventName: text("event_name").notNull().unique(), // e.g. "new_indent_placed", "order_confirmed"
  targetChannel: text("target_channel").notNull(), // "dealers" | "admin"
  pushEnabled: text("push_enabled").notNull().default("true"), // stored as text for consistency
  smsEnabled: text("sms_enabled").notNull().default("false"),
  emailEnabled: text("email_enabled").notNull().default("false"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
