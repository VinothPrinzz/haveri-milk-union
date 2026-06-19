// apps/web/src/lib/stock-buckets.ts
// ════════════════════════════════════════════════════════════════════
// Stock-entry bucket taxonomy.
//
// The plant runs two physical SK diaries — one for milk + curd,
// another for everything else. The UI mirrors that split (two pages)
// so each diary's data-entry person can be gated by role:
//
//   • inventory.update.milk-curd  → Stock Entry — Milk & Curd page
//   • inventory.update.others     → Stock Entry — Other Products page
//
// Single source of truth: edit MILK_CURD_CATEGORIES below to retune
// the split (e.g. add "Lassi" or "Buttermilk"). Both the frontend
// filter and the backend SQL filter read this same list.
// ════════════════════════════════════════════════════════════════════

export const MILK_CURD_CATEGORIES = ["Milk", "Curd", "Lassi", "Buttermilk"] as const;

export type StockBucket = "milk-curd" | "others";

/** Case-insensitive, whitespace-tolerant category match. */
export function isMilkOrCurd(category: string | null | undefined): boolean {
  const c = String(category ?? "").trim().toLowerCase();
  return MILK_CURD_CATEGORIES.some(x => x.toLowerCase() === c);
}

export function bucketOf(category: string | null | undefined): StockBucket {
  return isMilkOrCurd(category) ? "milk-curd" : "others";
}

/** Keeps only the rows belonging to the given bucket. */
export function filterByBucket<T extends { category?: string | null }>(
  rows: T[],
  bucket: StockBucket,
): T[] {
  return rows.filter(r =>
    bucket === "milk-curd" ? isMilkOrCurd(r.category) : !isMilkOrCurd(r.category),
  );
}

export const BUCKET_LABELS: Record<StockBucket, string> = {
  "milk-curd": "Milk & Curd",
  "others":    "Other Products",
};

export const BUCKET_SUBTITLES: Record<StockBucket, string> = {
  "milk-curd": "Daily entry from the milk & curd SK diary",
  "others":    "Daily entry from the other-products SK diary",
};

/**
 * Which stock buckets a role may view/edit. The two bucket-scoped FGS roles
 * are limited to a single SK diary; everyone else sees both. Mirrors
 * bucketsForRole() in apps/api/src/routes/inventory.ts — the server enforces
 * this, the client uses it only to hide the inaccessible Stock Entry page.
 */
export function allowedBucketsForRole(role: string | null | undefined): StockBucket[] {
  switch (role) {
    case "fgs_milk_curd": return ["milk-curd"];
    case "fgs_others":    return ["others"];
    default:              return ["milk-curd", "others"];
  }
}