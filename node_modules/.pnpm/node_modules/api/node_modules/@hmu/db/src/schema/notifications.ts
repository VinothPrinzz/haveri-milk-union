import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { deliveryStatusEnum, notifChannelEnum } from "./enums.js";

// ── Notifications Log ──
// Tracks all sent notifications with target, title, message, delivery status.
// Used for auditing and debugging push notification delivery.
export const notificationsLog = pgTable("notifications_log", {
  id: uuid("id").defaultRandom().primaryKey(),
  targetType: text("target_type").notNull(), // "dealer" | "admin" | "zone" | "all"
  targetId: uuid("target_id"), // dealer_id or user_id; null if broadcast
  channel: notifChannelEnum("channel").notNull(),
  title: text("title").notNull(),
  message: text("message").notNull(),
  data: text("data"), // JSON payload for deep linking
  status: deliveryStatusEnum("status").notNull().default("queued"),
  errorMessage: text("error_message"), // error details if failed
  sentAt: timestamp("sent_at", { withTimezone: true }),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_notifications_target").on(table.targetType, table.targetId),
  index("idx_notifications_status").on(table.status),
  index("idx_notifications_created").on(table.createdAt),
]);
