// ═══════════════════════════════════════════════════════════════════════
// diag-subsidy-ghee-missing.ts — SCAN (read-only).
//
// Findings so far:
//   • "subsidy ghee" = GHEE SACHET 500ML (PD0167), the ONLY active row in
//     employee_subsidy_rules (50% → ₹288.16, activated 2026-08-01).
//   • It is sold via POST /direct-sales/employee-subsidy → direct_sales +
//     direct_sale_items. All Indents (GET /orders) and the Dispatch Sheet
//     (GET /dispatch-sheet) read orders + order_items only → invisible.
//   • All 5 real sales (2026-08-01) have route_id NULL (form sends none;
//     all 27 employees have employees.route_id NULL), so even the Route
//     Sheet — which DOES support employee subsidy — drops them.
//
// This pass maps what it takes to promote employee subsidy into a real
// indent: FK shape of orders/invoices, how employees would host an order,
// and which ledger the credit currently lands in.
//
// USAGE (from apps/api):  npx tsx src/diag-subsidy-ghee-missing.ts
// ═══════════════════════════════════════════════════════════════════════

import { pgClient } from "./lib/db.js";

async function main() {
  console.log("── 1. orders: NOT NULL columns + FKs ─────────────────────");
  const ocols = await pgClient`
    SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
     WHERE table_name = 'orders' ORDER BY ordinal_position
  `;
  console.table(ocols);

  console.log("\n── 2. FK constraints on orders / invoices / order_items ──");
  const fks = await pgClient`
    SELECT tc.table_name, tc.constraint_name, tc.constraint_type,
           kcu.column_name,
           ccu.table_name  AS ref_table,
           ccu.column_name AS ref_column
      FROM information_schema.table_constraints tc
      LEFT JOIN information_schema.key_column_usage kcu
             ON kcu.constraint_name = tc.constraint_name
      LEFT JOIN information_schema.constraint_column_usage ccu
             ON ccu.constraint_name = tc.constraint_name
     WHERE tc.table_name IN ('orders','order_items','invoices')
       AND tc.constraint_type IN ('FOREIGN KEY','UNIQUE','PRIMARY KEY')
     ORDER BY tc.table_name, tc.constraint_type, tc.constraint_name
  `;
  console.table(fks);

  console.log("\n── 3. dealers.customer_type values in use ────────────────");
  const ct = await pgClient`
    SELECT customer_type, COUNT(*)::int AS n
      FROM dealers WHERE deleted_at IS NULL
     GROUP BY customer_type ORDER BY 2 DESC
  `;
  console.table(ct);

  console.log("\n── 4. dealers: NOT NULL columns (cost of a shadow row) ───");
  const dcols = await pgClient`
    SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
     WHERE table_name = 'dealers' AND is_nullable = 'NO'
     ORDER BY ordinal_position
  `;
  console.table(dcols);

  console.log("\n── 5. invoices: shape ────────────────────────────────────");
  const icols = await pgClient`
    SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
     WHERE table_name = 'invoices' ORDER BY ordinal_position
  `;
  console.table(icols);

  console.log("\n── 6. employee ledger vs dealer ledger (credit landing) ──");
  const led = await pgClient`
    SELECT 'employee_ledger' AS t, reference_type::text AS reference_type,
           COUNT(*)::int AS n
      FROM employee_ledger GROUP BY reference_type
     UNION ALL
    SELECT 'dealer_ledger', reference_type::text, COUNT(*)::int
      FROM dealer_ledger GROUP BY reference_type
     ORDER BY 1, 3 DESC
  `;
  console.table(led);

  console.log("\n── 7. employees: NOT NULL columns ────────────────────────");
  const ecols = await pgClient`
    SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
     WHERE table_name = 'employees' ORDER BY ordinal_position
  `;
  console.log((ecols as any[]).map(c => `${c.column_name}${c.is_nullable === 'NO' ? '*' : ''}`).join(", "));

  await pgClient.end();
}

main().catch(async (e) => { console.error(e); await pgClient.end(); process.exit(1); });
