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

  // Address (v1.4)
  addressType: z.enum(["Office", "Residence"]).or(z.literal("")).optional().default(""),
  state: z.string().default("Karnataka"),
  zoneId: z.string().optional().default(""),  // = Taluka (mapped to zones)
  city: z.string().default(""),
  area: z.string().default(""),
  houseNo: z.string().default(""),
  street: z.string().default(""),
  pinCode: z.string().default(""),
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

  // Assignment — per-route pay (rate per km/trip + total km/day differ per route)
  routeRates:    z.array(z.object({
    routeId:       z.string(),
    totalKmPerDay: z.coerce.number().min(0).default(0),
    ratePerTrip:   z.coerce.number().min(0).default(0),
  })).default([]),
  active:        z.boolean().default(true),
});

export type ContractorFormData = z.infer<typeof contractorSchema>;

// ══════════════════════════════════════════════════════════════════
// Supplier schema — stock vendors master (Masters → Suppliers)
// ══════════════════════════════════════════════════════════════════
export const supplierSchema = z.object({
  name:      z.string().min(2, "Name required").default(""),
  phone:     z.string().default(""),
  gstNo:     z.string().default(""),
  accountNo: z.string().default(""),
  address:   z.string().default(""),
  active:    z.boolean().default(true),
});

export type SupplierFormData = z.infer<typeof supplierSchema>;

// ══════════════════════════════════════════════════════════════════
// Route schema — Marketing v1.4
//   • removed `dispatchTime` (moved to batches)
//   • removed `taluka` (zoneId is the source of truth now)
//   • added `primaryBatchId` (required at submit time via app logic)
// ══════════════════════════════════════════════════════════════════
export const routeSchema = z.object({
  code:           z.string().default(""),
  name:           z.string().min(2, "Route name required").default(""),
  contractorId:   z.string().optional().default(""),
  primaryBatchId: z.string().optional().default(""),
  dispatchTime:   z.string().regex(/^\d{2}:\d{2}$/, "Use HH:MM").optional().default(""),
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
});

export type BatchFormData = z.infer<typeof batchSchema>;

// Import / co-locate the same constant (or import from a shared package):
export const REPORT_ALIAS_MAX: Record<"Across" | "Down", number> = {
  Across: 14,
  Down:   22,
};

// Accepts "", null, undefined → null; otherwise a non-negative number.
// z.coerce.number() alone won't preserve null (coerces null→0), hence the
// preprocess wrapper.
const optionalQty = (integer = false) =>
  z.preprocess(
    v => {
      if (v === "" || v === null || v === undefined) return null;
      const n = Number(v);
      return Number.isNaN(n) ? null : n;
    },
    integer ? z.number().int().min(0).nullable()
            : z.number().min(0).nullable(),
  );

// Fix #10w: productSchema — all fields get proper defaults
export const productSchema = z.object({
  name: z.string().min(2, "Product name required").default(""),
  reportAlias: z.string().default(""),
  category: z.string().min(1, "Category required").default(""),
  packSize:     optionalQty(),      // was z.coerce.number().positive().default(1)
  unit: z.string().min(1, "Unit required").default(""),
  dealerPrice: z.coerce.number().min(0).default(0),  // Dealer-Price (client-entered)
  mrp:         z.coerce.number().min(0).default(0),  // MRP (client-entered)
  gstPercent: z.coerce.number().min(0).max(100).default(0),
  hsnNo: z.string().default(""),
  subsidy: z.boolean().default(false),
  subRate: z.coerce.number().min(0).default(0),
  indentInBox: z.boolean().default(false),
  boxQty: z.coerce.number().int().min(0).default(0),
  sortPosition: z.coerce.number().int().min(0).default(0),
  packetsCrate: optionalQty(true), // was z.coerce.number().int().min(0).default(0)
  printDirection: z.enum(["Across", "Down"]).default("Across"),
  makeZeroInIndents: z.boolean().default(false),
  terminated: z.boolean().default(false),
  imageUrl: z.string().optional().default(""),
}).superRefine((data, ctx) => {
  if (!data.reportAlias) return;
  const direction = (data.printDirection ?? "Across") as "Across" | "Down";
  const maxLen    = REPORT_ALIAS_MAX[direction];
  if (data.reportAlias.length > maxLen) {
    ctx.addIssue({
      code:    z.ZodIssueCode.too_big,
      type:    "string",
      maximum: maxLen,
      inclusive: true,
      message: `Max ${maxLen} characters for ${direction} products`,
      path:    ["reportAlias"],
    });
  }
});

export type ProductFormData = z.infer<typeof productSchema>;