// apps/api/src/lib/stock-buckets.ts
// ════════════════════════════════════════════════════════════════════
// Single backend source of truth for the stock/dispatch bucket taxonomy.
//
// The plant runs two physical SK diaries — one for Milk + Curd, another
// for everything else — and the two bucket-scoped FGS logins are limited
// to their own diary. Both the Stock Entry/Overview (inventory.ts) and the
// Dispatch Sheet (dispatch-sheet.ts) scope their data by this taxonomy.
//
// Mirrors the frontend copy at apps/web/src/lib/stock-buckets.ts —
// keep MILK_CURD_CATEGORIES and bucketsForRole() in sync across both.
// ════════════════════════════════════════════════════════════════════

export type StockBucket = "milk-curd" | "others";

// Lower-cased category names that belong to the Milk & Curd diary.
// Keep in sync with apps/web/src/lib/stock-buckets.ts MILK_CURD_CATEGORIES.
export const MILK_CURD_CATEGORIES = ["milk", "curd", "lassi", "buttermilk"];

export const bucketOfCategory = (category: string | null | undefined): StockBucket =>
  MILK_CURD_CATEGORIES.includes(String(category ?? "").trim().toLowerCase())
    ? "milk-curd"
    : "others";

/**
 * Which buckets a role may view/edit. The two bucket-scoped FGS roles
 * (the SKA milk & curd diary vs. the other-products diary) are limited to a
 * single bucket; everyone else with access sees both.
 */
export function bucketsForRole(role: string): StockBucket[] {
  switch (role) {
    case "fgs_milk_curd": return ["milk-curd"];
    case "fgs_others":    return ["others"];
    default:              return ["milk-curd", "others"];
  }
}
