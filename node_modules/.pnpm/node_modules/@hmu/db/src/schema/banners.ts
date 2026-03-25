import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  date,
  integer,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { zones } from "./zones.js";

// ── Banners ──
// Promotional banners displayed in the dealer app.
// zone_id null = shown to all zones.
export const banners = pgTable("banners", {
  id: uuid("id").defaultRandom().primaryKey(),
  title: text("title").notNull(),
  subtitle: text("subtitle"),
  imageUrl: text("image_url"), // Cloudflare R2 URL
  linkUrl: text("link_url"), // optional deep link or external URL
  zoneId: uuid("zone_id").references(() => zones.id, { onDelete: "set null" }), // null = all zones
  startDate: date("start_date").notNull(),
  endDate: date("end_date").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_banners_dates").on(table.startDate, table.endDate),
  index("idx_banners_zone").on(table.zoneId),
]);

// ── Relations ──
export const bannersRelations = relations(banners, ({ one }) => ({
  zone: one(zones, {
    fields: [banners.zoneId],
    references: [zones.id],
  }),
}));
