// One-off re-baseline: set today's OPENING for one product to a counted value.
//
// This is the escape hatch migration 0063 left for exactly this case — Opening
// is no longer typeable in the UI, so a physical re-count is applied by setting
// the day's row with opening_manual = true. fgs_day then serves that value
// verbatim for today, and tomorrow carries forward from it.
//
// Usage: PRODUCT_ID=<uuid> OPENING=<int> npx tsx src/set-opening-pd0061.ts
import { pgClient } from "./lib/db.js";

const PRODUCT_ID = process.env.PRODUCT_ID ?? "97c2532d-58a9-468f-80e5-97766fe736dc";
const NEW_OPENING = Number(process.env.OPENING ?? 23);

async function main() {
  if (!Number.isInteger(NEW_OPENING) || NEW_OPENING < 0) {
    throw new Error(`OPENING must be a non-negative integer, got ${NEW_OPENING}`);
  }

  const [{ d: today }] = await pgClient`
    SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS d
  ` as any[];

  const [before] = await pgClient`
    SELECT p.code, p.name, f.opening, f.received, f.dispatched, f.wastage,
           f.closing, f.opening_manual
      FROM fgs_stock_log f
      JOIN products p ON p.id = f.product_id
     WHERE f.product_id = ${PRODUCT_ID}::uuid AND f.date = ${today}::date
  ` as any[];
  if (!before) throw new Error(`no fgs_stock_log row for ${PRODUCT_ID} on ${today}`);
  console.log(`${before.code} ${before.name} — ${today}`);
  console.log(`  before: opening=${before.opening} received=${before.received} dispatched=${before.dispatched} wastage=${before.wastage} closing=${before.closing}`);

  await pgClient.begin(async (_tx) => {
    const tx = _tx as unknown as typeof pgClient;

    // Set the opening and flag it, so fgs_day serves it rather than carrying
    // forward. dispatched/closing are derived on read; the stored copies are
    // re-synced below just to keep raw table reads coherent.
    await tx`
      UPDATE fgs_stock_log
         SET opening = ${NEW_OPENING}, opening_manual = true, updated_at = now()
       WHERE product_id = ${PRODUCT_ID}::uuid AND date = ${today}::date
    `;
    await tx`
      UPDATE fgs_stock_log f
         SET dispatched = d.dispatched, closing = d.closing, updated_at = now()
        FROM fgs_day(${today}::date) d
       WHERE f.product_id = d.product_id
         AND f.product_id = ${PRODUCT_ID}::uuid
         AND f.date = ${today}::date
    `;
    // Keep the vestigial products.stock counter in step (what POST /fgs/update
    // does on every save).
    await tx`
      UPDATE products p
         SET stock = d.closing, updated_at = now()
        FROM fgs_day(${today}::date) d
       WHERE p.id = d.product_id AND p.id = ${PRODUCT_ID}::uuid
    `;
  });

  const [after] = await pgClient`
    SELECT f.opening, f.received, f.dispatched, f.wastage, f.closing, f.opening_manual
      FROM fgs_stock_log f
     WHERE f.product_id = ${PRODUCT_ID}::uuid AND f.date = ${today}::date
  ` as any[];
  console.log(`  after:  opening=${after.opening} received=${after.received} dispatched=${after.dispatched} wastage=${after.wastage} closing=${after.closing} manual=${after.opening_manual}`);

  const [live] = await pgClient`
    SELECT opening, received, dispatched, wastage, closing
      FROM fgs_day(${today}::date) WHERE product_id = ${PRODUCT_ID}::uuid
  ` as any[];
  const [avail] = await pgClient`
    SELECT fgs_available(${PRODUCT_ID}::uuid, ${today}::date) AS a
  ` as any[];
  const [tom] = await pgClient`
    SELECT opening FROM fgs_day((${today}::date + 1)) WHERE product_id = ${PRODUCT_ID}::uuid
  ` as any[];
  console.log(`\n  app shows today: opening=${live.opening} dispatched=${live.dispatched} closing=${live.closing}`);
  console.log(`  order gate: ${avail.a}   dealer app sees: ${Math.max(0, Number(live.closing))}`);
  console.log(`  tomorrow opens at: ${tom?.opening}`);

  await pgClient.end();
}

main().catch(async (e) => { console.error(e); await pgClient.end(); process.exit(1); });
