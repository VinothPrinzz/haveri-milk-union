// ⚠ SUPERSEDED by migration 0072 — DO NOT RUN.
//
// This was the hand patch for the bug 0072 fixes at the source: direct sales
// were invisible to the FGS model, so a 5-unit vip_sample left 3 phantom units
// on the sheet. 0072 makes direct sales a real outflow stream AND reverts the
// re-baseline this script wrote. Running it again would re-apply a manual
// opening on top of a model that now derives the same number by itself,
// subtracting the sample twice. Kept only as the record of what was done.
//
// WRITES. One-off: zero out today's available stock for PD0205 KHARABOONDI 180GM.
//
// WHY. Adhoc/direct sales are not wired into the FGS sheet, so GP-0029 (5 units,
// vip_sample, dispatched 2026-08-06 10:23) left the floor without ever coming
// off stock. The sheet still shows 3 available that physically are not there.
//
// HOW. Migration 0063 makes opening a pure carry-forward, with opening_manual as
// the documented escape hatch for a physical re-count: write today's row with the
// counted opening and the flag set, and the chain continues from there. Wastage
// is deliberately NOT used — the units were sold as a sample, not wasted, and
// wastage feeds its own reports.
//
//   target: opening = dispatched(today) = 3  ->  closing = 3 + 0 - 3 - 0 = 0
//
// Idempotent: re-running recomputes the same opening from today's committed qty.
//
// USAGE (from apps/api):  npx tsx src/diag-zero-kharaboondi-180.ts
import { pgClient } from "./lib/db.js";

const CODE = "PD0205";

const [{ today }] = (await pgClient`
  SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS today
`) as any[];

const [prod] = (await pgClient`
  SELECT id, code, name FROM products
   WHERE code = ${CODE} AND deleted_at IS NULL
`) as any[];
if (!prod) throw new Error(`product ${CODE} not found`);

// PD0205 owns its own stock, but resolve the variant chain anyway so this is
// correct if that ever changes (migration 0059).
const [{ stock_id: stockId }] = (await pgClient`
  SELECT COALESCE(stock_source_product_id, id) AS stock_id
    FROM products WHERE id = ${prod.id}::uuid
`) as any[];

async function snapshot(label: string) {
  const [d] = (await pgClient`
    SELECT opening, received, dispatched, wastage, closing
      FROM fgs_day(${today}::date) WHERE product_id = ${stockId}::uuid
  `) as any[];
  const [{ n }] = (await pgClient`
    SELECT fgs_available(${stockId}::uuid, ${today}::date) AS n
  `) as any[];
  console.log(
    `${label}  opening=${d.opening} received=${d.received} dispatched=${d.dispatched} ` +
      `wastage=${d.wastage} closing=${d.closing}   fgs_available=${n}`,
  );
  return { ...d, available: Number(n) };
}

console.log(`${prod.code} ${prod.name}   IST date ${today}\n`);
const before = await snapshot("BEFORE:");

if (before.available === 0) {
  console.log("\nAlready at zero — nothing to do.");
  await pgClient.end();
  process.exit(0);
}

// The units still committed to today's live dealer orders have to stay covered,
// so the counted opening is exactly that figure: everything above it is the
// phantom stock the adhoc sale already consumed.
const countedOpening = Number(before.dispatched);

await pgClient.begin(async (_tx) => {
  const tx = _tx as unknown as typeof pgClient;

  await tx`
    INSERT INTO fgs_stock_log
      (product_id, date, opening, received, dispatched, wastage, closing,
       entered_by, opening_manual)
    VALUES
      (${stockId}::uuid, ${today}::date, ${countedOpening},
       ${Number(before.received)}, ${Number(before.dispatched)},
       ${Number(before.wastage)},
       ${countedOpening + Number(before.received) - Number(before.dispatched) - Number(before.wastage)},
       (SELECT f.entered_by FROM fgs_stock_log f ORDER BY f.created_at DESC LIMIT 1),
       true)
    ON CONFLICT (product_id, date) DO UPDATE SET
      opening        = EXCLUDED.opening,
      closing        = EXCLUDED.closing,
      opening_manual = true,
      updated_at     = now()
  `;

  // dispatched/closing are derived on read; keep the stored copies in step so
  // anyone querying fgs_stock_log directly sees what the app shows.
  await tx`
    UPDATE fgs_stock_log f
       SET dispatched = d.dispatched, closing = d.closing, updated_at = now()
      FROM fgs_day(${today}::date) d
     WHERE f.product_id = d.product_id
       AND f.product_id = ${stockId}::uuid
       AND f.date = ${today}::date
       AND (f.dispatched, f.closing) IS DISTINCT FROM (d.dispatched, d.closing)
  `;
});

const after = await snapshot("AFTER: ");

// The dealer app reads availability through fgs_available, but products.stock is
// the vestigial counter some legacy screens still show — park it at 0 too so
// nothing reports a stale 3.
await pgClient`UPDATE products SET stock = 0 WHERE id = ${stockId}::uuid`;
console.log("\nproducts.stock (vestigial counter) parked at 0.");

console.log(
  after.available === 0
    ? "\nDone — KHARABOONDI 180GM now reads 0 available."
    : `\nWARNING: available is ${after.available}, expected 0.`,
);

await pgClient.end();
