import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { zones } from "./zones.js";

// ── Contractors ──
// Milk collection agents / transport contractors distinct from dealer-customers.
// Each contractor may be assigned to one or more routes via routes.contractor_id.
export const contractors = pgTable("contractors", {
  id: uuid("id").defaultRandom().primaryKey(),
  code: text("code"),
  name: text("name").notNull(),
  phone: text("phone").notNull(),
  zoneId: uuid("zone_id").references(() => zones.id, { onDelete: "set null" }),
  address: text("address"),
  // Marketing v1.4
  accountNo:     text("account_no"),
  addressType:   text("address_type"), // "Office" | "Residence"
  state:         text("state").default("Karnataka"),
  area:          text("area"),
  houseNo:       text("house_no"),
  street:        text("street"),
  lastIndentAt:  timestamp("last_indent_at", { withTimezone: true }),
  
  vehicleNumber: text("vehicle_number"),    // primary vehicle
  licenseNumber: text("license_number"),    // transport license
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }), // soft delete
}, (table) => [
  index("idx_contractors_zone").on(table.zoneId),
  index("idx_contractors_active").on(table.active),
]);

// ── Relations ──
export const contractorsRelations = relations(contractors, ({ one }) => ({
  zone: one(zones, {
    fields: [contractors.zoneId],
    references: [zones.id],
  }),
}));
