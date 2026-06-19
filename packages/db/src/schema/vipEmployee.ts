import {
    pgTable, uuid, text, boolean, timestamp, numeric, integer, index, uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { products } from "./products.js";

// ── VIP Contacts ──
// Master list of VIPs who receive complimentary samples.
export const vipContacts = pgTable("vip_contacts", {
id:          uuid("id").defaultRandom().primaryKey(),
name:        text("name").notNull(),
phone:       text("phone"),
designation: text("designation"),
notes:       text("notes"),
createdAt:   timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
updatedAt:   timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
deletedAt:   timestamp("deleted_at", { withTimezone: true }),
}, (table) => [
index("idx_vip_contacts_name").on(table.name),
index("idx_vip_contacts_phone").on(table.phone),
]);

// ── Employees ──
// Master list of internal employees eligible for subsidised purchases.
export const employees = pgTable("employees", {
id:           uuid("id").defaultRandom().primaryKey(),
employeeCode: text("employee_code"),
name:         text("name").notNull(),
phone:        text("phone"),
department:   text("department"),
designation:  text("designation"),
active:       boolean("active").notNull().default(true),
// Route assignment (migration 0037)
routeId:        uuid("route_id"),
routePosition:  integer("route_position").notNull().default(9999),
// Credit (migration 0048) — finance-managed; mirrors dealers.
creditLimit:     numeric("credit_limit", { precision: 14, scale: 2 }).notNull().default("0"),
openingBalance:  numeric("opening_balance", { precision: 14, scale: 2 }).notNull().default("0"),
createdAt:    timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
updatedAt:    timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
deletedAt:    timestamp("deleted_at", { withTimezone: true }),
}, (table) => [
uniqueIndex("uq_employees_code").on(table.employeeCode),
index("idx_employees_name").on(table.name),
index("idx_employees_active").on(table.active),
]);

// ── Employee Subsidy Rules ──
// Per-product subsidy %. Only `active = true` rules apply.
// Server clamps employee-subsidy direct sales to these products.
export const employeeSubsidyRules = pgTable("employee_subsidy_rules", {
id:             uuid("id").defaultRandom().primaryKey(),
productId:      uuid("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
subsidyPercent: numeric("subsidy_percent", { precision: 5, scale: 2 }).notNull(),
active:         boolean("active").notNull().default(true),
createdAt:      timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
updatedAt:      timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
uniqueIndex("uq_emp_subsidy_active_product").on(table.productId),
]);

// ── Relations ──
export const employeeSubsidyRulesRelations = relations(employeeSubsidyRules, ({ one }) => ({
product: one(products, {
    fields: [employeeSubsidyRules.productId],
    references: [products.id],
}),
}));