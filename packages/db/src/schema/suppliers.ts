import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

// ── Suppliers ──
// Vendors the plant purchases received stock from. Selected by name on the
// Stock Entry screen and referenced by stock_receipts. Distinct from
// dealers (customers) and contractors (transport/collection agents).
export const suppliers = pgTable("suppliers", {
  id: uuid("id").defaultRandom().primaryKey(),
  code: text("code"),
  name: text("name").notNull(),
  phone: text("phone"),
  address: text("address"),
  gstNo: text("gst_no"),
  accountNo: text("account_no"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }), // soft delete
}, (table) => [
  index("idx_suppliers_active").on(table.active),
  index("idx_suppliers_name").on(table.name),
]);
