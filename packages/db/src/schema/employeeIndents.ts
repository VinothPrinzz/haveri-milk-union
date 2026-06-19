// ═══════════════════════════════════════════════════════════════════════
// Employee Standing Indents + Orders + Ledger — Drizzle Schema
// packages/db/src/schema/employeeIndents.ts
//
// Mirrors migration 0048_employee_indents.sql. A parallel, employee-keyed
// copy of the dealer standing-indent / orders / ledger machinery. Employees
// have no app login, so the whole flow is admin/worker-driven and priced at
// the employee-subsidy rate.
// ═══════════════════════════════════════════════════════════════════════

import {
  pgTable, uuid, text, boolean, timestamp, integer, numeric, date,
  index, uniqueIndex, check,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { employees } from "./vipEmployee.js";
import { products } from "./products.js";
import { orderStatusEnum, paymentModeEnum, ledgerTypeEnum } from "./enums.js";

// ── Standing indent rows ─────────────────────────────────────────────
export const employeeStandingIndents = pgTable(
  "employee_standing_indents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    defaultQty: integer("default_qty").notNull().default(0),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_employee_standing_indents_emp_product").on(
      table.employeeId,
      table.productId
    ),
    index("idx_employee_standing_indents_active")
      .on(table.employeeId)
      .where(sql`active = true AND default_qty > 0`),
    check("employee_default_qty_nonneg", sql`default_qty >= 0`),
  ]
);

// ── Materialized daily indent order ──────────────────────────────────
export const employeeOrders = pgTable(
  "employee_orders",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "restrict" }),
    routeId: uuid("route_id"),
    status: orderStatusEnum("status").notNull().default("draft"),
    paymentMode: paymentModeEnum("payment_mode").notNull().default("credit"),
    subtotal: numeric("subtotal", { precision: 14, scale: 2 }).notNull().default("0"),
    totalGst: numeric("total_gst", { precision: 14, scale: 2 }).notNull().default("0"),
    grandTotal: numeric("grand_total", { precision: 14, scale: 2 }).notNull().default("0"),
    itemCount: integer("item_count").notNull().default(0),
    deliveryDate: date("delivery_date").notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancellationReason: text("cancellation_reason"),
    placedBy: uuid("placed_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_employee_orders_emp_delivery_draft")
      .on(table.employeeId, table.deliveryDate)
      .where(sql`status = 'draft'`),
    index("idx_employee_orders_emp_date").on(table.employeeId, table.deliveryDate),
    index("idx_employee_orders_status").on(table.status, table.deliveryDate),
  ]
);

// ── Order line items ─────────────────────────────────────────────────
export const employeeOrderItems = pgTable(
  "employee_order_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    employeeOrderId: uuid("employee_order_id")
      .notNull()
      .references(() => employeeOrders.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    productName: text("product_name").notNull(),
    quantity: integer("quantity").notNull(),
    unitPrice: numeric("unit_price", { precision: 14, scale: 2 }).notNull(),
    gstPercent: numeric("gst_percent", { precision: 5, scale: 2 }).notNull().default("0"),
    gstAmount: numeric("gst_amount", { precision: 14, scale: 2 }).notNull().default("0"),
    lineTotal: numeric("line_total", { precision: 14, scale: 2 }).notNull(),
    subsidyPercent: numeric("subsidy_percent", { precision: 5, scale: 2 }).notNull().default("0"),
    mrpReference: numeric("mrp_reference", { precision: 14, scale: 2 }).notNull().default("0"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_employee_order_items_order").on(table.employeeOrderId)]
);

// ── Append-only credit ledger ────────────────────────────────────────
export const employeeLedger = pgTable(
  "employee_ledger",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    type: ledgerTypeEnum("type").notNull(),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    referenceId: uuid("reference_id"),
    referenceType: text("reference_type"),
    voucherType: text("voucher_type"),
    voucherDate: date("voucher_date").notNull().defaultNow(),
    description: text("description"),
    balanceAfter: numeric("balance_after", { precision: 14, scale: 2 }),
    performedBy: uuid("performed_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_employee_ledger_employee").on(table.employeeId, table.createdAt)]
);

// ── Relations ────────────────────────────────────────────────────────
export const employeeStandingIndentsRelations = relations(
  employeeStandingIndents,
  ({ one }) => ({
    employee: one(employees, {
      fields: [employeeStandingIndents.employeeId],
      references: [employees.id],
    }),
    product: one(products, {
      fields: [employeeStandingIndents.productId],
      references: [products.id],
    }),
  })
);

export const employeeOrdersRelations = relations(employeeOrders, ({ one, many }) => ({
  employee: one(employees, {
    fields: [employeeOrders.employeeId],
    references: [employees.id],
  }),
  items: many(employeeOrderItems),
}));

export const employeeOrderItemsRelations = relations(employeeOrderItems, ({ one }) => ({
  order: one(employeeOrders, {
    fields: [employeeOrderItems.employeeOrderId],
    references: [employeeOrders.id],
  }),
  product: one(products, {
    fields: [employeeOrderItems.productId],
    references: [products.id],
  }),
}));

export const employeeLedgerRelations = relations(employeeLedger, ({ one }) => ({
  employee: one(employees, {
    fields: [employeeLedger.employeeId],
    references: [employees.id],
  }),
}));
