import {
  pgTable,
  uuid,
  text,
  timestamp,
  numeric,
  date,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { settlementStatusEnum } from "./enums.js";
import { dealers } from "./dealers.js";

// ── Settlements ──
// Batch settlement records for dealer payments.
export const settlements = pgTable("settlements", {
  id: uuid("id").defaultRandom().primaryKey(),
  settlementDate: date("settlement_date").notNull(),
  totalAmount: numeric("total_amount", { precision: 14, scale: 2 }).notNull(),
  dealerCount: numeric("dealer_count").notNull(),
  status: settlementStatusEnum("status").notNull().default("pending"),
  bankReference: text("bank_reference"),
  notes: text("notes"),
  processedBy: uuid("processed_by"), // admin user
  processedAt: timestamp("processed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_settlements_date").on(table.settlementDate),
  index("idx_settlements_status").on(table.status),
]);

// ── Bank Reconciliation Entries ──
// For matching bank statements against internal records.
export const bankReconciliation = pgTable("bank_reconciliation", {
  id: uuid("id").defaultRandom().primaryKey(),
  date: date("date").notNull(),
  bankStatementAmount: numeric("bank_statement_amount", { precision: 14, scale: 2 }).notNull(),
  systemAmount: numeric("system_amount", { precision: 14, scale: 2 }).notNull(),
  difference: numeric("difference", { precision: 14, scale: 2 }).notNull(),
  status: text("status").notNull().default("pending"), // pending, matched, discrepancy
  notes: text("notes"),
  reconciledBy: uuid("reconciled_by"), // admin user
  reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_bank_recon_date").on(table.date),
]);
