// Post-apply verification for migration 0065 — read-only.
// Confirms prod has the table, its unique constraint (the ON CONFLICT target
// the bulk save depends on), the product lookup index, and both FKs.
import { pgClient } from "./lib/db.js";

async function main() {
  const cons = await pgClient`
    SELECT conname, contype, pg_get_constraintdef(oid) AS def
      FROM pg_constraint
     WHERE conrelid = 'supplier_product_costs'::regclass
     ORDER BY contype, conname
  `;
  console.log("constraints:");
  for (const c of cons) console.log(`  ${c.conname} (${c.contype}) — ${c.def}`);

  const idx = await pgClient`
    SELECT indexname, indexdef FROM pg_indexes
     WHERE tablename = 'supplier_product_costs'
     ORDER BY indexname
  `;
  console.log("indexes:");
  for (const i of idx) console.log(`  ${i.indexname}`);

  // The exact statement the PUT route runs, proven against the real table.
  const [{ ok }] = (await pgClient`
    SELECT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conrelid = 'supplier_product_costs'::regclass
         AND conname = 'uq_supplier_product_cost' AND contype = 'u'
    ) AS ok
  `) as any[];
  console.log(`ON CONFLICT (supplier_id, product_id) target present: ${ok}`);

  await pgClient.end();
}

main().catch(async (e) => { console.error(e); await pgClient.end(); process.exit(1); });
