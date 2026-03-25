import {
  pgTable,
  uuid,
  text,
  timestamp,
  numeric,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { ledgerTypeEnum, ledgerRefTypeEnum } from "./enums.js";
import { dealers } from "./dealers.js";

// ── Dealer Ledger ──
// CRITICAL: This table is APPEND-ONLY. No UPDATE, no DELETE. Ever.
// Every transaction — order debit, wallet credit, refund — is an INSERT
// with the running balance_after. This makes auditing trivial and prevents
// accidental data loss.
//
// The accountant can query this table directly for reconciliation.
export const dealerLedger = pgTable("dealer_ledger", {
  id: uuid("id").defaultRandom().primaryKey(),
  dealerId: uuid("dealer_id")
    .notNull()
    .references(() => dealers.id, { onDelete: "restrict" }),
  type: ledgerTypeEnum("type").notNull(), // credit or debit
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(), // always positive
  referenceId: uuid("reference_id"), // order_id, topup_id, refund_id etc.
  referenceType: ledgerRefTypeEnum("reference_type").notNull(), // wallet_topup, order, refund, adjustment
  description: text("description"), // human-readable note
  balanceAfter: numeric("balance_after", { precision: 12, scale: 2 }).notNull(), // running balance after this entry
  performedBy: uuid("performed_by"), // admin user if manual, null if system
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // NO updatedAt — this table is never updated
  // NO deletedAt — this table is never soft-deleted
}, (table) => [
  index("idx_dealer_ledger_dealer_created").on(table.dealerId, table.createdAt),
  index("idx_dealer_ledger_reference").on(table.referenceId, table.referenceType),
  index("idx_dealer_ledger_type").on(table.type),
]);

// ── Relations ──
export const dealerLedgerRelations = relations(dealerLedger, ({ one }) => ({
  dealer: one(dealers, {
    fields: [dealerLedger.dealerId],
    references: [dealers.id],
  }),
}));
