import {
  pgTable,
  uuid,
  text,
  timestamp,
  numeric,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { dealers } from "./dealers.js";

// ── Invoices ──
// One per order. Invoice number format: INV-HMU-YYYY-XXXX
// GST-compliant with CGST and SGST split for GSTR-1 filing.
// PDF generated on-demand when user clicks download, stored in Cloudflare R2.
export const invoices = pgTable("invoices", {
  id: uuid("id").defaultRandom().primaryKey(),
  orderId: uuid("order_id").notNull(), // reference to orders (partitioned, no FK constraint)
  dealerId: uuid("dealer_id")
    .notNull()
    .references(() => dealers.id, { onDelete: "restrict" }),
  invoiceNumber: text("invoice_number").notNull().unique(), // INV-HMU-2025-0001 format
  invoiceDate: timestamp("invoice_date", { withTimezone: true }).notNull().defaultNow(),
  taxableAmount: numeric("taxable_amount", { precision: 12, scale: 2 }).notNull(), // before tax
  cgst: numeric("cgst", { precision: 10, scale: 2 }).notNull(), // Central GST (half of total GST)
  sgst: numeric("sgst", { precision: 10, scale: 2 }).notNull(), // State GST (half of total GST)
  totalTax: numeric("total_tax", { precision: 10, scale: 2 }).notNull(), // cgst + sgst
  totalAmount: numeric("total_amount", { precision: 12, scale: 2 }).notNull(), // taxableAmount + totalTax
  dealerGstNumber: text("dealer_gst_number"), // snapshot at invoice time
  dealerName: text("dealer_name").notNull(), // snapshot at invoice time
  dealerAddress: text("dealer_address"), // snapshot at invoice time
  pdfUrl: text("pdf_url"), // Cloudflare R2 URL, null until generated
  pdfGeneratedAt: timestamp("pdf_generated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_invoices_order").on(table.orderId),
  index("idx_invoices_dealer").on(table.dealerId),
  index("idx_invoices_number").on(table.invoiceNumber),
  index("idx_invoices_date").on(table.invoiceDate),
]);

// ── Relations ──
export const invoicesRelations = relations(invoices, ({ one }) => ({
  dealer: one(dealers, {
    fields: [invoices.dealerId],
    references: [dealers.id],
  }),
}));
