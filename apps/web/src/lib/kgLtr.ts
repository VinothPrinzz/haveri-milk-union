// apps/web/src/lib/kgLtr.ts
// ════════════════════════════════════════════════════════════════════
// Qty (Kg/Ltr) — derived straight from the product's DB fields
// (products.pack_size + products.unit), never from parsing the product
// name / report alias.
//
// In this dataset pack_size is always stored in the product's *macro* unit
// (L or kg) — e.g. HTM 1000ML = 1.00 L, CURD 140GM = 0.14 kg, and the
// multi-packs G/L UHT 180 ML "30 PACK" = 5.40 L (30 × 180 ml), 100 ML
// "60 PACK" = 6.00 L. So one sold/ordered unit's true volume is simply
// packets × pack_size. The unit column only says whether that figure reads
// as Ltr (milk) or Kg (curd).
//
// Micro units (ml / g) are still selectable on the product form; if one is
// ever used, pack_size holds the sub-unit size and converts ÷1000. Anything
// else (L, kg, blank) is treated as already-macro and used as-is — this is
// what fixed the multi-pack SKUs that the old alias-parsing under-reported
// by their pack count (e.g. "180 ML" read as 0.18 L instead of 5.4 L).
// ════════════════════════════════════════════════════════════════════
export function computeKgLtr(packets: number, packSize: number, unit: string): number {
  const u = (unit ?? "").trim().toLowerCase();
  const isMicro =
    u === "ml" || u === "g" || u === "gm" || u === "gram" || u === "grams";
  const perPack = isMicro ? packSize / 1000 : packSize;
  return (Number(packets) || 0) * (Number(perPack) || 0);
}
