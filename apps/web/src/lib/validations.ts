// ══════════════════════════════════════════════════════════════════
// MICRO-PHASE A — VALIDATION SCHEMA FIXES
// File: apps/web/src/lib/validations.ts
//
// Replace the ENTIRE file with this content.
// Changes marked with "// Fix #Xw" comments.
// ══════════════════════════════════════════════════════════════════

import { z } from "zod";

// ══════════════════════════════════════════════════════════════════
// Customer schema — Marketing v1.4
// ══════════════════════════════════════════════════════════════════
export const customerSchema = z.object({
  // Identity
  name: z.string().min(2, "Name required").default(""),
  phone: z.string().min(10, "Valid phone required").default(""),
  email: z.string().email("Invalid email").or(z.literal("")).optional().default(""),

  // Business
  type: z
    .enum(["Retail-Dealer", "Credit Inst-MRP", "Credit Inst-Dealer", "Parlour-Dealer"])
    .default("Retail-Dealer"),
  rateCategory: z.string().default("Retail-Dealer"),
  payMode: z.enum(["Cash", "Credit"]).default("Cash"),
  officerName: z.string().default(""),
  bank: z.string().default(""),
  accountNo: z.string().default(""),
  creditLimit: z.coerce.number().min(0).default(0),

  // Address (v1.4)
  addressType: z.enum(["Office", "Residence"]).or(z.literal("")).optional().default(""),
  state: z.string().default("Karnataka"),
  zoneId: z.string().optional().default(""),  // = Taluka (mapped to zones)
  city: z.string().default(""),
  area: z.string().default(""),
  houseNo: z.string().default(""),
  street: z.string().default(""),
  address: z.string().default(""),            // free-form full address (optional)

  // Assignment
  routeId: z.string().optional().default(""),
  active: z.boolean().default(true),
});

export type CustomerFormData = z.infer<typeof customerSchema>;

// ══════════════════════════════════════════════════════════════════
// Contractor schema — Marketing v1.4
// ══════════════════════════════════════════════════════════════════
export const contractorSchema = z.object({
  // Identity
  name:          z.string().min(2, "Name required").default(""),
  phone:         z.string().min(10, "Valid phone required").default(""),
  email:         z.string().email("Invalid email").or(z.literal("")).optional().default(""),
  licenseNumber: z.string().default(""),

  // Business
  bankName:      z.string().default(""),
  accountNo:     z.string().default(""),
  ratePerKm:     z.coerce.number().min(0).default(0),
  vehicleNumber: z.string().default(""),

  // Period
  periodFrom:    z.string().optional().default(""),
  periodTo:      z.string().optional().default(""),

  // Address
  addressType:   z.enum(["Office", "Residence"]).or(z.literal("")).optional().default(""),
  state:         z.string().default("Karnataka"),
  city:          z.string().default(""),
  area:          z.string().default(""),
  houseNo:       z.string().default(""),
  street:        z.string().default(""),
  address:       z.string().default(""),

  // Assignment
  routeIds:      z.array(z.string()).default([]),
  active:        z.boolean().default(true),
});

export type ContractorFormData = z.infer<typeof contractorSchema>;

// ══════════════════════════════════════════════════════════════════
// Route schema — Marketing v1.4
//   • removed `dispatchTime` (moved to batches)
//   • removed `taluka` (zoneId is the source of truth now)
//   • added `primaryBatchId` (required at submit time via app logic)
// ══════════════════════════════════════════════════════════════════
export const routeSchema = z.object({
  code:           z.string().default(""),
  name:           z.string().min(2, "Route name required").default(""),
  zoneId:         z.string().min(1, "Taluka required").default(""),
  contractorId:   z.string().optional().default(""),
  primaryBatchId: z.string().optional().default(""),
  active:         z.boolean().default(true),
});

export type RouteFormData = z.infer<typeof routeSchema>;

// ══════════════════════════════════════════════════════════════════
// Batch schema — Marketing v1.4
//   • added `dispatchTime` (time-of-day, HH:MM, optional)
// ══════════════════════════════════════════════════════════════════
export const batchSchema = z.object({
  batchCode:    z.string().min(1, "Batch code required").default(""),
  whichBatch:   z.enum(["Morning", "Afternoon", "Evening", "Night"]).default("Morning"),
  timing:       z.string().min(1, "Timing required").default(""),
  dispatchTime: z.string().optional().default(""),   // "HH:MM" — matches <input type="time">
});

export type BatchFormData = z.infer<typeof batchSchema>;

// Fix #10w: productSchema — all fields get proper defaults
export const productSchema = z.object({
  name: z.string().min(2, "Product name required").default(""),        // Fix #10w
  reportAlias: z.string().default(""),                                  // Fix #10w
  category: z.string().min(1, "Category required").default(""),        // Fix #10w — this is category UUID
  packSize: z.coerce.number().positive().default(1),                   // Fix #10: coerce
  unit: z.string().min(1, "Unit required").default(""),                // Fix #10w
  mrp: z.coerce.number().min(0).default(0),                           // Fix #10: coerce
  gstPercent: z.coerce.number().min(0).max(100).default(0),           // Fix #10: coerce
  hsnNo: z.string().default(""),                                       // Fix #10w
  subsidy: z.boolean().default(false),
  subRate: z.coerce.number().min(0).default(0),
  indentInBox: z.boolean().default(false),
  boxQty: z.coerce.number().int().min(0).default(0),
  sortPosition: z.coerce.number().int().min(0).default(0),
  packetsCrate: z.coerce.number().int().min(0).default(0),
  printDirection: z.enum(["Across", "Down"]).default("Across"),
  makeZeroInIndents: z.boolean().default(false),
});
export type ProductFormData = z.infer<typeof productSchema>;