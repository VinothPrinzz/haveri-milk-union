// READ ONLY in effect — every scenario runs inside a transaction that is ROLLED
// BACK, so production data is never modified.
//
// Reproduces the exact failure that stranded PD0245: an operator saves a day,
// then goes back and edits an EARLIER day. Before the fix, the later entries'
// stored openings stayed frozen at their pre-edit values and the carry-forward
// chain broke silently (closing(D) <> opening(D+1)). This asserts that
// propagateOpeningsForward repairs the chain, and — by running the same edit
// with propagation skipped — that the test would actually FAIL without it.
//
// USAGE (from apps/api):  npx tsx src/diag-verify-forward-propagation.ts
import { pgClient } from "./lib/db.js";
import { propagateOpeningsForward } from "./routes/inventory.js";

const CODE = "PD0245";

const [prod] = (await pgClient`
  SELECT id, code, name FROM products WHERE code = ${CODE} AND deleted_at IS NULL
`) as any[];
if (!prod) throw new Error(`${CODE} not found`);

/** Consecutive-entry breaks for one product: closing(D) vs opening(next entry),
 *  allowing for orders committed on days that have no entry at all. */
async function breaks(client: any): Promise<any[]> {
  return (await client`
    WITH e AS (
      SELECT f.date,
             LEAD(f.date) OVER (ORDER BY f.date) AS next_date
        FROM fgs_stock_log f
       WHERE f.product_id = ${prod.id}::uuid
         AND f.date >= (SELECT MIN(date) FROM fgs_stock_log WHERE opening_manual)
    ),
    g AS (
      SELECT e.*, COALESCE((
        SELECT SUM(oi.quantity)::int
          FROM orders o
          JOIN order_items oi ON oi.order_id = o.id
          JOIN products pp ON pp.id = oi.product_id
         WHERE COALESCE(pp.stock_source_product_id, pp.id) = ${prod.id}::uuid
           AND o.stock_deducted AND o.status <> 'cancelled'
           AND o.delivery_date > e.date AND o.delivery_date < e.next_date), 0) AS skipped
        FROM e WHERE e.next_date IS NOT NULL
    )
    SELECT g.date::text AS d, g.next_date::text AS nd,
           c.closing AS close_d, n.opening AS open_next,
           (n.opening - (c.closing - g.skipped)) AS unexplained
      FROM g
      CROSS JOIN LATERAL fgs_day(g.date) c
      CROSS JOIN LATERAL fgs_day(g.next_date) n
     WHERE c.product_id = ${prod.id}::uuid AND n.product_id = ${prod.id}::uuid
       AND n.opening IS DISTINCT FROM (c.closing - g.skipped)
  `) as any[];
}

/** Stored openings that disagree with what the chain derives. */
async function drift(client: any): Promise<any[]> {
  return (await client`
    SELECT f.date::text AS d, f.opening AS stored, x.opening AS derived
      FROM fgs_stock_log f
      CROSS JOIN LATERAL fgs_day(f.date) x
     WHERE x.product_id = f.product_id
       AND f.product_id = ${prod.id}::uuid
       AND NOT f.opening_manual
       AND f.date >= (SELECT MIN(date) FROM fgs_stock_log WHERE opening_manual)
       AND f.opening IS DISTINCT FROM x.opening
  `) as any[];
}

/**
 * Simulate the Stock Entry save of ONE earlier day: bump its received (the edit),
 * write back the derived opening/dispatched/closing for that date exactly as the
 * route does, then optionally propagate forward.
 */
async function simulateEdit(tx: any, editDate: string, bump: number, propagate: boolean) {
  await tx`
    UPDATE fgs_stock_log SET received = received + ${bump}, updated_at = now()
     WHERE product_id = ${prod.id}::uuid AND date = ${editDate}::date
  `;
  // What the route writes for the saved date itself.
  await tx`
    UPDATE fgs_stock_log f
       SET opening = x.opening, dispatched = x.dispatched, closing = x.closing,
           updated_at = now()
      FROM fgs_day(${editDate}::date) x
     WHERE x.product_id = f.product_id
       AND f.product_id = ${prod.id}::uuid
       AND f.date = ${editDate}::date
  `;
  if (propagate) return await propagateOpeningsForward(tx, prod.id, editDate);
  return [];
}

async function scenario(label: string, editDate: string, bump: number, propagate: boolean) {
  console.log(`\n══ ${label} ══`);
  let result: { breaks: any[]; drift: any[]; propagated: string[] } = {
    breaks: [], drift: [], propagated: [],
  };
  try {
    await pgClient.begin(async (_tx) => {
      const tx = _tx as unknown as typeof pgClient;
      const propagated = await simulateEdit(tx, editDate, bump, propagate);
      result = { breaks: await breaks(tx), drift: await drift(tx), propagated };
      throw new Error("__ROLLBACK__");
    });
  } catch (e: any) {
    if (e?.message !== "__ROLLBACK__") throw e;
  }
  console.log(`  edited ${editDate} (received ${bump >= 0 ? "+" : ""}${bump}), propagate=${propagate}`);
  if (propagate) console.log(`  re-derived later entries: [${result.propagated.join(", ")}]`);
  console.log(`  carry-forward breaks: ${result.breaks.length}`);
  for (const b of result.breaks)
    console.log(`    ${b.d} close=${b.close_d} -> ${b.nd} open=${b.open_next}  unexplained=${b.unexplained}`);
  console.log(`  stored openings out of step: ${result.drift.length}`);
  for (const d of result.drift) console.log(`    ${d.d} stored=${d.stored} derived=${d.derived}`);
  return result;
}

console.log(`${prod.code} ${prod.name} — forward-propagation check (all scenarios roll back)`);

const base = await scenario("BASELINE (no edit)", "2026-08-04", 0, false);
const without = await scenario("edit the 4th, WITHOUT propagation (the old bug)", "2026-08-04", 10, false);
const with_ = await scenario("edit the 4th, WITH propagation (the fix)", "2026-08-04", 10, true);

console.log("\n──────── verdict ────────");
let ok = true;
if (base.breaks.length !== 0 || base.drift.length !== 0) {
  console.log("FAIL: the product is not clean before the test even starts.");
  ok = false;
}
if (without.breaks.length === 0 && without.drift.length === 0) {
  console.log("FAIL: editing an earlier day without propagating did NOT break the chain —");
  console.log("      the test cannot prove the fix does anything.");
  ok = false;
} else {
  console.log(`OK: without propagation the edit breaks the chain (${without.breaks.length} break(s), ${without.drift.length} stale opening(s)).`);
}
if (with_.breaks.length !== 0 || with_.drift.length !== 0) {
  console.log("FAIL: propagation left the chain broken.");
  ok = false;
} else {
  console.log(`OK: with propagation the chain stays intact (re-derived ${with_.propagated.length} later entries).`);
}
console.log(ok ? "\nPASS" : "\nFAIL");

await pgClient.end();
process.exit(ok ? 0 : 1);
