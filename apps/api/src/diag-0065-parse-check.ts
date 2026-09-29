// ═══════════════════════════════════════════════════════════════════════
// diag-0065-parse-check.ts — proves migration 0065's DDL and the three new
// supplier-cost queries parse and plan, WITHOUT leaving anything behind.
//
// Everything runs inside one transaction that is deliberately rolled back:
// the table is created, each query is EXPLAINed against it (EXPLAIN plans
// but never executes), then the transaction aborts. Nothing is committed.
//
// Bindings are substituted with NULL, which is sound here — every one sits
// in a `${x}::type IS NULL OR ...` guard or is a plain equality operand.
//
// USAGE (from apps/api):  npx tsx src/diag-0065-parse-check.ts
// ═══════════════════════════════════════════════════════════════════════
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pgClient } from "./lib/db.js";

const here = dirname(fileURLToPath(import.meta.url));
const sqlPath = join(here, "../../../packages/db/src/migrations/0065_supplier_product_costs.sql");

const QUERIES: Array<{ name: string; sql: string }> = [
  {
    name: "GET /supplier-costs",
    sql: `
      SELECT spc.supplier_id AS "supplierId",
             spc.product_id  AS "productId",
             spc.unit_cost   AS "unitCost",
             spc.updated_at  AS "updatedAt"
        FROM supplier_product_costs spc
        JOIN suppliers s ON s.id = spc.supplier_id
       WHERE s.deleted_at IS NULL
         AND (NULL::uuid IS NULL OR spc.supplier_id = NULL::uuid)
         AND (NULL::uuid IS NULL OR spc.product_id = NULL::uuid)
    `,
  },
  {
    name: "GET /suppliers/:id/costs (editor rows)",
    sql: `
      SELECT p.id            AS "productId",
             p.code          AS "productCode",
             p.name          AS "productName",
             p.unit,
             c.name          AS "categoryName",
             spc.unit_cost   AS "unitCost",
             spc.updated_at  AS "updatedAt"
        FROM products p
        JOIN categories c ON c.id = p.category_id
        LEFT JOIN supplier_product_costs spc
               ON spc.product_id = p.id AND spc.supplier_id = NULL
       WHERE p.deleted_at IS NULL
         AND p.code IS DISTINCT FROM 'PD0191S'
       ORDER BY c.name, p.sort_order, p.name
    `,
  },
  {
    name: "PUT /suppliers/:id/costs — delete leg",
    sql: `
      DELETE FROM supplier_product_costs
       WHERE supplier_id = NULL AND product_id = NULL
    `,
  },
  {
    name: "PUT /suppliers/:id/costs — upsert leg",
    sql: `
      INSERT INTO supplier_product_costs (supplier_id, product_id, unit_cost, updated_by)
      VALUES (NULL, NULL, NULL::numeric, NULL)
      ON CONFLICT (supplier_id, product_id) DO UPDATE SET
        unit_cost  = EXCLUDED.unit_cost,
        updated_by = EXCLUDED.updated_by,
        updated_at = now()
    `,
  },
];

const ROLLBACK = Symbol("rollback");

async function main() {
  const ddl = readFileSync(sqlPath, "utf8");
  const failures: string[] = [];

  try {
    await pgClient.begin(async (_tx) => {
      const tx = _tx as unknown as typeof pgClient;
      await tx.unsafe(ddl);
      console.log("DDL applied inside the transaction ✓");

      for (const q of QUERIES) {
        try {
          await tx.unsafe(`EXPLAIN ${q.sql}`);
          console.log(`  ok   ${q.name}`);
        } catch (e: any) {
          failures.push(`${q.name}: ${e.message}`);
          console.log(`  FAIL ${q.name}: ${e.message}`);
        }
      }

      // Abort — this check must leave the database exactly as it found it.
      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }

  const [{ exists }] = (await pgClient`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables WHERE table_name = 'supplier_product_costs'
    ) AS exists
  `) as any[];
  console.log(`rolled back — supplier_product_costs still present? ${exists}`);

  await pgClient.end();
  if (failures.length) process.exit(1);
}

main().catch(async (e) => { console.error(e); await pgClient.end(); process.exit(1); });
