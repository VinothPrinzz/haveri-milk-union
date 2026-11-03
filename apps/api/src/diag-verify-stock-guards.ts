// READ ONLY. Exercises the new read-only stock guards against live data:
//   • findStockEntryOversells (Stock Entry save guard)
//   • getDemandShortfalls     (pre-checks used by admin-place / Modify)
// USAGE (from apps/api):  npx tsx src/diag-verify-stock-guards.ts
import { pgClient } from "./lib/db.js";
import { findStockEntryOversells } from "./routes/inventory.js";
import { getDemandShortfalls } from "./lib/stock-check.js";

const id = async (code: string) =>
  String(((await pgClient`SELECT id FROM products WHERE code = ${code}`) as any[])[0].id);
const muffin = await id("PD0024");
const bun = await id("PD0287");
const [{ today }] = (await pgClient`SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS today`) as any[];
const log = async (code: string, d: string) =>
  ((await pgClient`SELECT f.received, f.wastage FROM fgs_stock_log f JOIN products p ON p.id=f.product_id
                    WHERE p.code=${code} AND f.date=${d}::date`) as any[])[0];
console.log("today", today, "PD0024 14th stored:", await log("PD0024", "2026-10-14"));

const cases: [string, string, { productId: string; received: number; wastage: number }][] = [
  ["muffin 14th unchanged (rec 2)  → allow", "2026-10-14", { productId: muffin, received: 2, wastage: 0 }],
  ["muffin 14th rec 2→1            → allow (closing 0)", "2026-10-14", { productId: muffin, received: 1, wastage: 0 }],
  ["muffin 14th rec 2→0            → REFUSE", "2026-10-14", { productId: muffin, received: 0, wastage: 0 }],
  ["muffin 13th the real incident: rec 1→0 replayed as wastage 1 → REFUSE", "2026-10-13", { productId: muffin, received: 0, wastage: 1 }],
  ["muffin 14th rec 2→5 (increase)  → allow", "2026-10-14", { productId: muffin, received: 5, wastage: 0 }],
  ["sweet bun today wastage +1 (already −6) → REFUSE", today, { productId: bun, received: 0, wastage: 1 }],
  ["sweet bun today received 10 (fixes it)  → allow", today, { productId: bun, received: 10, wastage: 0 }],
];
for (const [label, date, e] of cases) {
  const r = await findStockEntryOversells(date, [e]);
  console.log(`${r.length ? "REFUSE" : "allow "}  ${label}`, r.length ? JSON.stringify(r[0]) : "");
}

console.log("\npre-check: 1 sweet bun today →", JSON.stringify(await getDemandShortfalls(pgClient, [{ productId: bun, quantity: 1 }], today)));
console.log("pre-check: 1 muffin today    →", JSON.stringify(await getDemandShortfalls(pgClient, [{ productId: muffin, quantity: 1 }], today)));
console.log("pre-check: 2 muffin today    →", JSON.stringify(await getDemandShortfalls(pgClient, [{ productId: muffin, quantity: 2 }], today)));
await pgClient.end();
