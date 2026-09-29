// WRITES (with dry run). Repairs the PD0245 RASAGULLA TIN 500GM carry-forward
// break between 2026-08-05 and 2026-08-06.
//
// THE BREAK. The sheet showed 08-05 closing at 4 and 08-06 opening at 7 — three
// units out of nowhere. Cause: the next day's carry-forward reads the STORED
// `opening` column, while the sheet displays the DERIVED opening, and for the
// 08-05 row those disagreed (stored 13, derived 10). The operator saved the 5th
// at 06:07:04 and then went back and edited the 4th at 06:08:33; the Stock Entry
// save only writes the opening for the date being saved (routes/inventory.ts),
// so nothing re-derived the 5th and its stored value froze at the pre-edit 13.
//
// THE REPAIR, as directed: correct the 6th's opening and book the difference as
// RECEIVED, because the three units are physically on the floor — they were
// never recorded as coming in. That is migration 0063's rule: every increase in
// stock is entered as Received, never absorbed into Opening.
//
//   08-05  stored opening 13 -> 10   (invisible on the sheet: it already
//                                     DISPLAYS 10; this only repairs the stale
//                                     cached column the 6th carries from)
//   08-06  opening 7 -> 4            (now derived correctly from 08-05's closing)
//          received 60 -> 63         (+3, the units that came in unrecorded)
//          closing stays 63          (the floor does not move)
//
// Today's availability is unchanged at 63. What changes is that the 63 is now
// honestly composed instead of resting on a phantom opening.
//
// USAGE (from apps/api):
//   npx tsx src/diag-fix-pd0245-carry-forward.ts            <- dry run
//   npx tsx src/diag-fix-pd0245-carry-forward.ts --apply    <- commit
import { pgClient } from "./lib/db.js";

const APPLY = process.argv.includes("--apply");
const CODE = "PD0245";
const PREV = "2026-08-05";
const DAY = "2026-08-06";

const [prod] = (await pgClient`
  SELECT id, code, name FROM products WHERE code = ${CODE} AND deleted_at IS NULL
`) as any[];
if (!prod) throw new Error(`${CODE} not found`);

async function show(client: any, label: string) {
  console.log(`\n${label}`);
  for (const d of [PREV, DAY, "2026-08-07"]) {
    const [x] = (await client`
      SELECT opening, received, dispatched, wastage, closing
        FROM fgs_day(${d}::date) WHERE product_id = ${prod.id}::uuid
    `) as any[];
    const [s] = (await client`
      SELECT opening AS s_open, received AS s_rec, closing AS s_close
        FROM fgs_stock_log WHERE product_id = ${prod.id}::uuid AND date = ${d}::date
    `) as any[];
    console.log(
      `  ${d}  derived: op=${String(x.opening).padStart(4)} rec=${String(x.received).padStart(4)} ` +
        `disp=${String(x.dispatched).padStart(3)} close=${String(x.closing).padStart(4)}` +
        (s ? `   stored: op=${String(s.s_open).padStart(4)} rec=${String(s.s_rec).padStart(4)} close=${String(s.s_close).padStart(4)}` : "   (no stored row)"),
    );
  }
}

console.log(`${prod.code} ${prod.name}${APPLY ? "" : "   — DRY RUN (rolls back)"}`);
await show(pgClient, "BEFORE:");

// The gap is computed, not hardcoded: stale stored opening minus the derived
// one. The same figure is what the 6th's opening drops by, so adding it to
// received holds the closing steady. Assert the two agree before writing.
const [gapRow] = (await pgClient`
  SELECT f.opening                                  AS stored_open,
         d.opening                                  AS derived_open,
         (f.opening - d.opening)                    AS gap
    FROM fgs_stock_log f
    JOIN fgs_day(${PREV}::date) d ON d.product_id = f.product_id
   WHERE f.product_id = ${prod.id}::uuid AND f.date = ${PREV}::date
`) as any[];
const gap = Number(gapRow?.gap ?? 0);
console.log(
  `\n  ${PREV} stored opening ${gapRow?.stored_open} vs derived ${gapRow?.derived_open}  ->  stale by ${gap}`,
);
if (gap === 0) {
  console.log("\nAlready repaired — nothing to do.");
  await pgClient.end();
  process.exit(0);
}

const [beforeDay] = (await pgClient`
  SELECT opening, closing FROM fgs_day(${DAY}::date) WHERE product_id = ${prod.id}::uuid
`) as any[];
// Today's availability is the number the dealer app serves. It must not move:
// the floor holds 63 either way, we are only changing how that 63 is composed.
const [{ availBefore }] = (await pgClient`
  SELECT fgs_available(${prod.id}::uuid, (now() AT TIME ZONE 'Asia/Kolkata')::date) AS "availBefore"
`) as any[];

try {
  await pgClient.begin(async (_tx) => {
    const tx = _tx as unknown as typeof pgClient;

    // 1. Repair the stale cached openings, walking FORWARD in date order.
    //    Order is the whole point: each row's stored opening is what the NEXT
    //    entry anchors on, so fixing day N changes what day N+1 derives. Doing
    //    this in one set-based pass would fix the 5th against the old chain and
    //    leave the 6th stale — which is precisely how this drift spread in the
    //    first place (the Stock Entry save never propagates forward either).
    const dates = (await tx`
      SELECT date::text AS d FROM fgs_stock_log
       WHERE product_id = ${prod.id}::uuid
         AND date >= (SELECT MIN(date) FROM fgs_stock_log WHERE opening_manual)
         AND NOT opening_manual
       ORDER BY date
    `) as any[];
    for (const { d } of dates) {
      await tx`
        UPDATE fgs_stock_log f
           SET opening = x.opening, updated_at = now()
          FROM fgs_day(${d}::date) x
         WHERE x.product_id = f.product_id
           AND f.product_id = ${prod.id}::uuid
           AND f.date = ${d}::date
           AND f.opening IS DISTINCT FROM x.opening
      `;
    }

    // 2. Book the units as received on the 6th, so the floor stays where it is
    //    now that the opening is correct. The amount is the drop the repair
    //    caused, read back rather than assumed.
    const [afterOpen] = (await tx`
      SELECT opening FROM fgs_day(${DAY}::date) WHERE product_id = ${prod.id}::uuid
    `) as any[];
    const drop = Number(beforeDay.opening) - Number(afterOpen.opening);
    console.log(`\n  ${DAY} opening ${beforeDay.opening} -> ${afterOpen.opening}; booking +${drop} as received`);
    if (drop !== gap)
      throw new Error(`opening dropped by ${drop} but the 08-05 staleness was ${gap} — unexpected`);
    await tx`
      UPDATE fgs_stock_log
         SET received = received + ${drop}, updated_at = now()
       WHERE product_id = ${prod.id}::uuid AND date = ${DAY}::date
    `;

    // 3. Keep the derived-on-read columns in step for this product.
    await tx`
      UPDATE fgs_stock_log f
         SET dispatched = d.dispatched, closing = d.closing, updated_at = now()
        FROM (SELECT s.date, fd.product_id, fd.dispatched, fd.closing
                FROM (SELECT DISTINCT date FROM fgs_stock_log
                       WHERE product_id = ${prod.id}::uuid) s
                CROSS JOIN LATERAL fgs_day(s.date) fd
               WHERE fd.product_id = ${prod.id}::uuid) d
       WHERE f.product_id = d.product_id
         AND f.date = d.date
         AND (f.dispatched, f.closing) IS DISTINCT FROM (d.dispatched, d.closing)
    `;

    await show(tx, "AFTER:");

    // ── verification, inside the transaction ──
    const [prev] = (await tx`
      SELECT closing FROM fgs_day(${PREV}::date) WHERE product_id = ${prod.id}::uuid
    `) as any[];
    const [day] = (await tx`
      SELECT opening, received, closing FROM fgs_day(${DAY}::date) WHERE product_id = ${prod.id}::uuid
    `) as any[];

    if (Number(day.opening) !== Number(prev.closing))
      throw new Error(`carry-forward still broken: closing(${PREV})=${prev.closing} vs opening(${DAY})=${day.opening}`);
    if (Number(day.closing) !== Number(beforeDay.closing))
      throw new Error(`closing on ${DAY} moved ${beforeDay.closing} -> ${day.closing}; the floor must not change`);
    if (Number(day.opening) !== Number(beforeDay.opening) - gap)
      throw new Error(`opening on ${DAY} should have dropped by exactly ${gap}`);

    // The check that caught the first attempt: repairing the 5th alone left the
    // 6th's stored opening stale, and today anchored on it — availability would
    // have silently risen 63 -> 66.
    const [{ availAfter }] = (await tx`
      SELECT fgs_available(${prod.id}::uuid, (now() AT TIME ZONE 'Asia/Kolkata')::date) AS "availAfter"
    `) as any[];
    if (Number(availAfter) !== Number(availBefore))
      throw new Error(
        `today's availability moved ${availBefore} -> ${availAfter}; the floor must not change`,
      );

    // No stored opening may remain out of step with the derived chain, or the
    // same drift simply reappears on the next entry.
    const [{ n: leftover }] = (await tx`
      SELECT count(*)::int AS n
        FROM fgs_stock_log f
        CROSS JOIN LATERAL fgs_day(f.date) d
       WHERE d.product_id = f.product_id
         AND f.product_id = ${prod.id}::uuid
         AND NOT f.opening_manual
         AND f.date >= (SELECT MIN(date) FROM fgs_stock_log WHERE opening_manual)
         AND f.opening IS DISTINCT FROM d.opening
    `) as any[];
    if (leftover !== 0) throw new Error(`${leftover} stored openings still disagree with the chain`);

    console.log(
      `\n  carry-forward intact: closing(${PREV})=${prev.closing} = opening(${DAY})=${day.opening}` +
        `\n  floor held: closing(${DAY})=${day.closing} (was ${beforeDay.closing})` +
        `\n  today's availability held: ${availAfter} (was ${availBefore})` +
        `\n  stored openings still out of step: ${leftover}`,
    );

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
