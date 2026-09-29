// ═══════════════════════════════════════════════════════════════════════
// diag-0066-parse-check.ts — proves migration 0066's DDL and the three
// changed dispatch-sheet queries parse and plan, WITHOUT leaving anything
// behind.
//
// Same shape as diag-0065-parse-check.ts: everything runs inside one
// transaction that is deliberately rolled back. The column is added, each
// query is EXPLAINed against it (EXPLAIN plans but never executes), then the
// transaction aborts. Nothing is committed — including the two UPDATEs.
//
// Bindings are substituted with literals of the right type. The dates are
// real dates rather than NULL because they sit in plain equality operands,
// and the ADHOC sentinel is spelled out because the CASE compares against it.
//
// USAGE (from apps/api):  npx tsx src/diag-0066-parse-check.ts
// ═══════════════════════════════════════════════════════════════════════
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pgClient } from "./lib/db.js";

const here = dirname(fileURLToPath(import.meta.url));
const sqlPath = join(here, "../../../packages/db/src/migrations/0066_direct_sales_dispatched_at.sql");

const D = `'2026-08-05'`;                                   // targetDate
const ADHOC = `'00000000-0000-0000-0000-000000000000'`;     // ADHOC_ROUTE_ID
const STATUSES = `ARRAY['pending','confirmed','dispatched']`;

const QUERIES: Array<{ name: string; sql: string }> = [
  {
    // The whole routes query, with the new adhoc_state CTE + CROSS JOIN and
    // the derived-status COALESCE. Filters are left unbound (NULL) exactly as
    // the "all routes, all batches, all buckets" request sends them.
    name: "GET /dispatch-sheet — routes (adhoc_state)",
    sql: `
      WITH route_orders AS (
        SELECT
          COALESCE(o.route_id, d.route_id) AS route_id,
          COUNT(DISTINCT o.id)::int AS order_count,
          COUNT(oi.id)::int AS line_count,
          COALESCE(SUM(oi.line_total), 0)::numeric AS total_amount
        FROM orders o
        JOIN dealers d        ON d.id = o.dealer_id
        JOIN order_items oi   ON oi.order_id = o.id
        JOIN products p       ON p.id = oi.product_id AND p.deleted_at IS NULL
        LEFT JOIN categories c ON c.id = p.category_id
        WHERE o.delivery_date = ${D}::date
          AND o.status::text = ANY(${STATUSES}::text[])
          AND COALESCE(o.route_id, d.route_id) IS NOT NULL
        GROUP BY COALESCE(o.route_id, d.route_id)
      ),
      employee_route_orders AS (
        SELECT
          COALESCE(eo.route_id, ${ADHOC}::uuid) AS route_id,
          COUNT(DISTINCT eo.id)::int AS order_count,
          COUNT(eoi.id)::int AS line_count,
          COALESCE(SUM(eoi.line_total), 0)::numeric AS total_amount
        FROM employee_orders eo
        JOIN employee_order_items eoi ON eoi.employee_order_id = eo.id
        JOIN products p       ON p.id = eoi.product_id AND p.deleted_at IS NULL
        LEFT JOIN categories c ON c.id = p.category_id
        WHERE eo.delivery_date = ${D}::date
          AND eo.status::text = ANY(${STATUSES}::text[])
        GROUP BY eo.route_id
      ),
      adhoc_route_orders AS (
        SELECT
          COALESCE(ds.route_id, ${ADHOC}::uuid) AS route_id,
          COUNT(DISTINCT ds.id)::int AS order_count,
          COUNT(dsi.id)::int AS line_count,
          COALESCE(SUM(dsi.line_total), 0)::numeric AS total_amount
        FROM direct_sales ds
        JOIN direct_sale_items dsi ON dsi.direct_sale_id = ds.id
        JOIN products p       ON p.id = dsi.product_id AND p.deleted_at IS NULL
        LEFT JOIN categories c ON c.id = p.category_id
        WHERE ds.sale_date = ${D}::date
          AND ds.customer_type IN ('cash', 'vip_sample', 'employee_subsidy')
        GROUP BY ds.route_id
      ),
      adhoc_state AS (
        SELECT
          COUNT(*) FILTER (WHERE NOT done)::int AS open_count,
          COUNT(*) FILTER (WHERE done)::int     AS done_count
        FROM (
          SELECT ds.dispatched_at IS NOT NULL AS done
            FROM direct_sales ds
           WHERE ds.sale_date = ${D}::date
             AND ds.route_id IS NULL
             AND ds.customer_type IN ('cash', 'vip_sample', 'employee_subsidy')
          UNION ALL
          SELECT eo.status::text = 'dispatched'
            FROM employee_orders eo
           WHERE eo.delivery_date = ${D}::date
             AND eo.route_id IS NULL
             AND eo.status::text IN ('confirmed', 'dispatched')
        ) s
      ),
      all_route_orders AS (
        SELECT route_id,
               SUM(order_count)::int      AS order_count,
               SUM(line_count)::int       AS line_count,
               SUM(total_amount)::numeric AS total_amount
          FROM (
            SELECT * FROM route_orders
            UNION ALL
            SELECT * FROM employee_route_orders
            UNION ALL
            SELECT * FROM adhoc_route_orders
          ) u
         GROUP BY route_id
      )
      SELECT
        ro.route_id   AS "routeId",
        COALESCE(r.code, 'ADHOC')                  AS "routeCode",
        COALESCE(r.name, 'Adhoc Sales (No Route)') AS "routeName",
        (r.id IS NULL) AS "isAdhoc",
        ct.name       AS "contractorName",
        COALESCE(ra.vehicle_number, ct.vehicle_number) AS "vehicleNumber",
        ra.driver_name AS "driverName",
        COALESCE(ra.departure_time::text, r.dispatch_time::text) AS "dispatchTime",
        COALESCE(
          ra.status::text,
          CASE WHEN ro.route_id = ${ADHOC}::uuid
                AND ast.open_count = 0
                AND ast.done_count > 0
               THEN 'dispatched' END,
          'pending'
        )             AS "status",
        ra.id         AS "assignmentId",
        ro.order_count   AS "dealerCount",
        ro.line_count    AS "lineCount",
        ro.total_amount  AS "totalAmount"
      FROM all_route_orders ro
      LEFT JOIN routes r      ON r.id = ro.route_id AND r.deleted_at IS NULL
      LEFT JOIN contractors ct ON ct.id = r.contractor_id AND ct.deleted_at IS NULL
      LEFT JOIN route_assignments ra
             ON ra.route_id = r.id AND ra.date = ${D}::date
      CROSS JOIN adhoc_state ast
      WHERE r.id IS NOT NULL OR ro.route_id = ${ADHOC}::uuid
      ORDER BY (r.id IS NULL), r.code
    `,
  },
  {
    name: "mark-dispatched — employee_orders cascade (adhoc leg)",
    sql: `
      UPDATE employee_orders SET
        status     = 'dispatched',
        updated_at = now()
      WHERE delivery_date = ${D}::date
        AND status = 'confirmed'
        AND ((true::boolean AND route_id IS NULL)
             OR (NOT true::boolean AND route_id = ${ADHOC}::uuid))
    `,
  },
  {
    name: "mark-dispatched — employee_orders cascade (real-route leg)",
    sql: `
      UPDATE employee_orders SET
        status     = 'dispatched',
        updated_at = now()
      WHERE delivery_date = ${D}::date
        AND status = 'confirmed'
        AND ((false::boolean AND route_id IS NULL)
             OR (NOT false::boolean AND route_id = ${ADHOC}::uuid))
    `,
  },
  {
    name: "mark-dispatched — direct_sales stamp (adhoc leg)",
    sql: `
      UPDATE direct_sales SET
        dispatched_at = COALESCE(dispatched_at, now()),
        updated_at    = now()
      WHERE sale_date = ${D}::date
        AND customer_type IN ('cash', 'vip_sample', 'employee_subsidy')
        AND dispatched_at IS NULL
        AND ((true::boolean AND route_id IS NULL)
             OR (NOT true::boolean AND route_id = ${ADHOC}::uuid))
    `,
  },
  {
    name: "mark-dispatched — direct_sales stamp (real-route leg)",
    sql: `
      UPDATE direct_sales SET
        dispatched_at = COALESCE(dispatched_at, now()),
        updated_at    = now()
      WHERE sale_date = ${D}::date
        AND customer_type IN ('cash', 'vip_sample', 'employee_subsidy')
        AND dispatched_at IS NULL
        AND ((false::boolean AND route_id IS NULL)
             OR (NOT false::boolean AND route_id = ${ADHOC}::uuid))
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
      SELECT 1 FROM information_schema.columns
       WHERE table_name = 'direct_sales' AND column_name = 'dispatched_at'
    ) AS exists
  `) as any[];
  console.log(`rolled back — direct_sales.dispatched_at still present? ${exists}`);

  await pgClient.end();
  if (failures.length) process.exit(1);
}

main().catch(async (e) => { console.error(e); await pgClient.end(); process.exit(1); });
