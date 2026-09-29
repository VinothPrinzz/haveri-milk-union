// WRITES (with dry run). Brings PD0167 GHEE SACHET 500ML's stored opening for
// 2026-08-06 into line with what the chain now derives.
//
// WHY. Migration 0072 added the employee subsidy rail as a real outflow, which
// moved that row's DERIVED opening from 23 to 21 (the 2-unit employee order on
// 08-04 now falls inside the carry-forward window). The migration deliberately
// re-synced only dispatched/closing, leaving every stored `opening` untouched —
// so the stored column stayed at 23. Availability anchors on the stored column,
// so the sheet showed 08-06 closing at 4367 while today opened at 4369.
//
// Unlike the PD0245 repair, NOTHING is booked as received here: those 2 units
// did not arrive, an employee subsidy order took them. The opening simply
// reaches its derived value and availability settles at the honest 4367.
//
// Walks forward in date order for the same reason as everywhere else in this
// model — a row's stored opening is what the NEXT entry anchors on. PD0167 has
// no entry after 08-06 today, but the loop is written to survive one appearing.
//
// USAGE (from apps/api):
//   npx tsx src/diag-fix-pd0167-opening-drift.ts            <- dry run
//   npx tsx src/diag-fix-pd0167-opening-drift.ts --apply    <- commit
import { pgClient } from "./lib/db.js";

const APPLY = process.argv.includes("--apply");
const CODE = "PD0167";
const EXPECTED_AVAIL = 4367;

const [prod] = (await pgClient`
  SELECT id, code, name FROM products WHERE code = ${CODE} AND deleted_at IS NULL
`) as any[];
if (!prod) throw new Error(`${CODE} not found`);

const [{ today }] = (await pgClient`
  SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS today
`) as any[];

/** Every stored opening that disagrees with the derived chain, all products. */
async function driftRows(client: any) {
  return (await client`
    SELECT p.code, f.date::text AS d, f.opening AS stored, x.opening AS derived
      FROM fgs_stock_log f
      JOIN products p ON p.id = f.product_id
      CROSS JOIN LATERAL fgs_day(f.date) x
     WHERE x.product_id = f.product_id
       AND f.date >= (SELECT MIN(date) FROM fgs_stock_log WHERE opening_manual)
       AND NOT f.opening_manual
       AND f.opening IS DISTINCT FROM x.opening
     ORDER BY p.code, f.date
  `) as any[];
}

const before = await driftRows(pgClient);
console.log(`${prod.code} ${prod.name}${APPLY ? "" : "   — DRY RUN (rolls back)"}\n`);
console.log("stored openings out of step with the chain, ALL products:");
for (const r of before) console.log(`  ${r.code} ${r.d}  stored=${r.stored} derived=${r.derived}`);

// Honour the standing "don't change openings" rule: this run is authorised for
// PD0167 / 2026-08-06 only. If the sweep turns up anything else, stop and ask
// rather than quietly rewriting another product's chain.
const unauthorised = before.filter(
  (r: any) => !(r.code === CODE && r.d === "2026-08-06"),
);
if (unauthorised.length > 0) {
  console.error(
    "\nREFUSING: drift found outside the authorised row: " +
      unauthorised.map((r: any) => `${r.code} ${r.d}`).join(", "),
  );
  await pgClient.end();
  process.exit(1);
}
if (before.length === 0) {
  console.log("\nAlready in step — nothing to do.");
  await pgClient.end();
  process.exit(0);
}

const [{ a: availBefore }] = (await pgClient`
  SELECT fgs_available(${prod.id}::uuid, ${today}::date) AS a
`) as any[];
console.log(`\navailability today BEFORE: ${availBefore}`);

try {
  await pgClient.begin(async (_tx) => {
    const tx = _tx as unknown as typeof pgClient;

    const dates = (await tx`
      SELECT date::text AS d FROM fgs_stock_log
       WHERE product_id = ${prod.id}::uuid
         AND date >= DATE '2026-08-06'
         AND NOT opening_manual
       ORDER BY date
    `) as any[];

    for (const { d } of dates) {
      await tx`
        UPDATE fgs_stock_log f
           SET opening    = x.opening,
               dispatched = x.dispatched,
               closing    = x.closing,
               updated_at = now()
          FROM fgs_day(${d}::date) x
         WHERE x.product_id = f.product_id
           AND f.product_id = ${prod.id}::uuid
           AND f.date       = ${d}::date
           AND (f.opening, f.dispatched, f.closing)
               IS DISTINCT FROM (x.opening, x.dispatched, x.closing)
      `;
    }

    const [row] = (await tx`
      SELECT f.opening AS stored, f.received, f.wastage, x.dispatched, x.closing
        FROM fgs_stock_log f
        CROSS JOIN LATERAL fgs_day(f.date) x
       WHERE x.product_id = f.product_id
         AND f.product_id = ${prod.id}::uuid AND f.date = DATE '2026-08-06'
    `) as any[];
    console.log(
      `\n2026-08-06 AFTER: opening=${row.stored} received=${row.received} ` +
        `dispatched=${row.dispatched} wastage=${row.wastage} closing=${row.closing}`,
    );

    const [{ a: availAfter }] = (await tx`
      SELECT fgs_available(${prod.id}::uuid, ${today}::date) AS a
    `) as any[];
    console.log(`availability today AFTER: ${availAfter}`);

    if (Number(availAfter) !== EXPECTED_AVAIL)
      throw new Error(`expected availability ${EXPECTED_AVAIL}, got ${availAfter}`);
    if (Number(row.received) !== 4416)
      throw new Error(`received must not change (expected 4416, got ${row.received})`);

    const leftover = await driftRows(tx);
    console.log(`stored openings still out of step, ALL products: ${leftover.length}`);
    if (leftover.length !== 0)
      throw new Error(`${leftover.length} rows still disagree with the chain`);

    const [{ n: negatives }] = (await tx`
      SELECT count(*)::int AS n FROM products p
       WHERE p.deleted_at IS NULL AND fgs_available(p.id, ${today}::date) < 0
    `) as any[];
    console.log(`products with negative availability: ${negatives}`);
    if (negatives !== 0) throw new Error(`${negatives} products went negative`);

    if (!APPLY) throw new Error("__DRY_RUN__");
  });
} catch (err: any) {
  if (err?.message === "__DRY_RUN__") {
    console.log("\n— dry run — rolled back. Re-run with --apply to commit.");
    await pgClient.end();
    process.exit(0);
  }
  console.error("\nFAILED — rolled back, nothing changed.");
  console.error(err.message ?? err);
  await pgClient.end().catch(() => {});
  process.exit(1);
}

console.log("\nCOMMITTED.");
await pgClient.end();
