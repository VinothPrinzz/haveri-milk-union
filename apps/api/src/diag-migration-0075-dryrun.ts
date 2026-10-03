// DRY RUN for migration 0075 and the Price Revisions fix. Applies the
// migration inside a transaction, drives the real save path
// (lib/price-revisions.ts) against live products, prints what it would
// write, then ROLLS BACK. Nothing is persisted.
//
// USAGE (from apps/api):  npx tsx src/diag-migration-0075-dryrun.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pgClient } from "./lib/db.js";
import {
  applyPriceRevision, recordPriceRevision, PriceRevisionError,
} from "./lib/price-revisions.js";
import { resolveUnitPrice } from "./lib/rate-price.js";

const here = dirname(fileURLToPath(import.meta.url));
const sqlPath = join(here, "../../../packages/db/src/migrations/0075_price_revisions_dealer_price_mrp.sql");

class Rollback extends Error {}

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
}

async function main() {
  const [admin] = await pgClient`SELECT id FROM users WHERE role = 'super_admin' ORDER BY created_at LIMIT 1`;
  const byCode = async (tx: typeof pgClient, code: string) => {
    const [p] = await tx`
      SELECT p.id, p.code, p.base_price, p.dealer_price, p.mrp, p.gst_percent, c.name AS category
      FROM products p JOIN categories c ON c.id = p.category_id
      WHERE p.code = ${code} AND p.deleted_at IS NULL`;
    return p!;
  };

  try {
    await pgClient.begin(async (_tx) => {
      const tx = _tx as unknown as typeof pgClient;
      const body = readFileSync(sqlPath, "utf8")
        .replace(/^\s*BEGIN\s*;\s*$/gim, "")
        .replace(/^\s*COMMIT\s*;\s*$/gim, "");
      await tx.unsafe(body);
      console.log("migration 0075 applied inside the transaction\n");

      // A. Milk, 0% GST: Dealer Price and MRP both move.
      console.log("A. HTM 1000ML (PD0191): Dealer 44.65 -> 45.10, MRP 47.00 -> 47.50");
      const a0 = await byCode(tx, "PD0191");
      const a = await applyPriceRevision(tx, {
        productId: a0.id, newDealerPrice: 45.10, newMrp: 47.50,
        changedBy: admin!.id, reason: "dry run",
      });
      const a1 = await byCode(tx, "PD0191");
      check("dealer_price is 45.10", Number(a1.dealer_price) === 45.10, a1.dealer_price);
      check("base_price re-derived to 45.10", Number(a1.base_price) === 45.10, a1.base_price);
      check("mrp is 47.50", Number(a1.mrp) === 47.50, a1.mrp);
      check("result reports the change", a?.oldDealerPrice === a0.dealer_price && Number(a?.newDealerPrice) === 45.10);
      const retail = resolveUnitPrice({ basePrice: a1.base_price, mrp: a1.mrp, gstPercent: a1.gst_percent, categoryName: a1.category, code: a1.code }, "Retail-Dealer");
      const ciMrp = resolveUnitPrice({ basePrice: a1.base_price, mrp: a1.mrp, gstPercent: a1.gst_percent, categoryName: a1.category, code: a1.code }, "Credit Inst-MRP");
      check("a Retail-Dealer order now bills 45.10", retail === 45.10, String(retail));
      check("a Credit Inst-MRP order now bills 47.50", ciMrp === 47.50, String(ciMrp));

      // B. 5% GST: Basic Price is Dealer / 1.05, to the paisa.
      console.log("\nB. MILLET MIX 200GM (P11, 5% GST): Dealer 107.14 -> 110.25");
      const b0 = await byCode(tx, "P11");
      await applyPriceRevision(tx, { productId: b0.id, newDealerPrice: 110.25, changedBy: admin!.id });
      const b1 = await byCode(tx, "P11");
      check("base_price = 110.25 / 1.05 = 105.00", Number(b1.base_price) === 105.00, b1.base_price);
      check("mrp untouched when not sent", b1.mrp === b0.mrp, `${b0.mrp} -> ${b1.mrp}`);

      // C. MRP-only change leaves the (3dp) Basic Price alone.
      console.log("\nC. PEDA JAGGERY 200GM (P08): MRP only, 140 -> 145");
      const c0 = await byCode(tx, "P08");
      await applyPriceRevision(tx, { productId: c0.id, newMrp: 145, changedBy: admin!.id });
      const c1 = await byCode(tx, "P08");
      check("mrp is 145", Number(c1.mrp) === 145, c1.mrp);
      check("base_price not rewritten", c1.base_price === c0.base_price, `${c0.base_price} -> ${c1.base_price}`);
      check("dealer_price not rewritten", c1.dealer_price === c0.dealer_price);

      // D. A line that matches the current prices writes nothing.
      console.log("\nD. Same prices as current");
      const d0 = await byCode(tx, "PD0193");
      const d = await applyPriceRevision(tx, {
        productId: d0.id, newDealerPrice: Number(d0.dealer_price), newMrp: Number(d0.mrp), changedBy: admin!.id,
      });
      check("returns null (no change)", d === null);

      // E. MRP below Dealer Price is refused (in a savepoint so the dry run goes on).
      console.log("\nE. MRP below the Dealer Price");
      let refused = "";
      try {
        await (_tx as any).savepoint(async (sp: typeof pgClient) => {
          await applyPriceRevision(sp, { productId: d0.id, newDealerPrice: 30, newMrp: 25, changedBy: admin!.id });
        });
      } catch (e) {
        if (e instanceof PriceRevisionError) refused = `${e.statusCode} ${e.message}`;
        else throw e;
      }
      check("refused with 400", refused.startsWith("400"), refused);

      // F. The All Products edit path logs through the same helper.
      console.log("\nF. All Products edit logging");
      const f0 = await byCode(tx, "P11");
      const noop = await recordPriceRevision(tx, {
        productId: f0.id,
        before: { basePrice: "102.038", dealerPrice: f0.dealer_price, mrp: f0.mrp, gstPercent: f0.gst_percent },
        after:  { basePrice: "102.04",  dealerPrice: f0.dealer_price, mrp: f0.mrp, gstPercent: f0.gst_percent },
        changedBy: admin!.id, source: "product_edit",
      });
      check("3dp -> 2dp normalisation is not a revision", noop === false);
      const logged = await recordPriceRevision(tx, {
        productId: f0.id,
        before: { basePrice: f0.base_price, dealerPrice: f0.dealer_price, mrp: f0.mrp, gstPercent: "5.00" },
        after:  { basePrice: f0.base_price, dealerPrice: f0.dealer_price, mrp: f0.mrp, gstPercent: "12.00" },
        changedBy: admin!.id, source: "product_edit",
      });
      check("a GST change is logged", logged === true);

      // G. The history query the page runs, with the new columns.
      console.log("\nG. GET /price-revisions history (as the page sees it)");
      const rows = await tx`
        SELECT p.code AS "productCode",
               pr.old_price AS "oldPrice", pr.new_price AS "newPrice",
               pr.old_dealer_price AS "oldDealerPrice", pr.new_dealer_price AS "newDealerPrice",
               pr.old_mrp AS "oldMrp", pr.new_mrp AS "newMrp",
               pr.old_gst_percent AS "oldGst", pr.new_gst_percent AS "newGst",
               pr.effective_from::text AS "effectiveFrom", pr.reason, pr.source,
               u.name AS "changedByName"
        FROM price_revisions pr
        JOIN products p ON p.id = pr.product_id
        LEFT JOIN users u ON u.id = pr.changed_by
        ORDER BY pr.effective_from DESC, pr.created_at DESC
        LIMIT 50 OFFSET 0
      `;
      for (const r of rows) console.log("  ", JSON.stringify(r));
      check("4 rows logged (A, B, C and the GST edit; D and the no-op wrote nothing)", rows.length === 4, `got ${rows.length}`);
      const [today] = await tx`SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS d`;
      check("effective_from is the IST day", rows.every((r: any) => r.effectiveFrom === today!.d), today!.d);

      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  console.log("\nAfter rollback:");
  const [n] = await pgClient`SELECT count(*)::int AS n FROM price_revisions`;
  const [col] = await pgClient`
    SELECT count(*)::int AS n FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'price_revisions' AND column_name = 'new_dealer_price'`;
  const [pd] = await pgClient`SELECT dealer_price, base_price, mrp FROM products WHERE code = 'PD0191' AND deleted_at IS NULL`;
  check("price_revisions still empty", n!.n === 0);
  check("migration not persisted", col!.n === 0);
  check("PD0191 prices untouched", Number(pd!.dealer_price) === 44.65 && Number(pd!.mrp) === 47, JSON.stringify(pd));

  console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
  await pgClient.end();
  if (failures) process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  await pgClient.end();
  process.exit(1);
});
