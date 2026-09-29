import {
  pgTable,
  uuid,
  text,
  boolean,
  numeric,
  timestamp,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { products } from "./products.js";

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

// ── Supplier Product Costs (purchase rate card) ──
// ONE current purchase rate per (supplier, product). Stock Entry pre-fills a
// receipt line's unit cost from here the moment a supplier is picked, so the
// operator stops re-keying the same rate every morning; the filled value can
// still be overridden for that one receipt.
//
// A default, NOT history: stock_receipts snapshots the unit_cost actually
// used, so revising a rate here never rewrites past purchases.
export const supplierProductCosts = pgTable("supplier_product_costs", {
  id: uuid("id").defaultRandom().primaryKey(),
  supplierId: uuid("supplier_id")
    .notNull()
    .references(() => suppliers.id, { onDelete: "cascade" }),
  productId: uuid("product_id")
    .notNull()
    .references(() => products.id, { onDelete: "cascade" }),
  unitCost: numeric("unit_cost", { precision: 11, scale: 3 }).notNull(),
  updatedBy: uuid("updated_by"), // admin user who last set the rate
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("uq_supplier_product_cost").on(table.supplierId, table.productId),
  index("idx_supplier_product_costs_product").on(table.productId),
]);

export const supplierProductCostsRelations = relations(supplierProductCosts, ({ one }) => ({
  supplier: one(suppliers, {
    fields: [supplierProductCosts.supplierId],
    references: [suppliers.id],
  }),
  product: one(products, {
    fields: [supplierProductCosts.productId],
    references: [products.id],
  }),
}));
