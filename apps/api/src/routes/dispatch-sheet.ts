// apps/api/src/routes/dispatch-sheet.ts
// ════════════════════════════════════════════════════════════════════
// Dispatch Sheet (revamp) + Create Dispatch endpoints.
//
// Three endpoints:
//
//   1. GET  /api/v1/dispatch-sheet
//      Returns per-route item-level aggregation for the loading
//      checklist UI. SUM/FLOOR/MOD happen in Postgres (NOT in Node)
//      to keep the response small even with 100+ dealers/route.
//      Covers the rails that move goods out of FGS on the day:
//      dealer orders, employee indents, and the adhoc counter sales
//      (cash / VIP sample / employee subsidy, plus gate passes issued
//      without a route — a routed gate pass rides its own report).
//      Adhoc sales and employee indents that name no route are
//      collected in one ADHOC bucket — see ADHOC_ROUTE_ID.
//
//   2. POST /api/v1/dispatch/create
//      Operator picks pending indents for a route+batch+date, fills
//      in vehicle/driver/dispatch-time, submits. We:
//         • upsert route_assignments for (route_id, date)
//         • move selected orders from 'pending' → 'confirmed'
//         • recompute dealer_count, item_count
//      All in one transaction. Idempotent via CTE-upsert.
//
//   3. POST /api/v1/dispatch-sheet/mark-dispatched
//      Operator clicks "Mark Dispatched" on a route accordion.
//      Cascades 'confirmed' → 'dispatched' but ONLY for that route's
//      dealers (existing PATCH /dispatch/assignments/:id incorrectly
//      cascades zone-wide; we don't reuse it). All three rails on the
//      card move together: dealer orders, employee indents and adhoc
//      sales (direct_sales.dispatched_at, migration 0066). Passing the
//      ADHOC sentinel as routeId closes out the no-route bucket, which
//      has no route_assignments row to flip.
//
// Performance notes:
//   • Aggregation query uses idx_orders_dispatch_status_created
//     from migration 0015 (partial composite, partition-pruned).
//   • Two queries per request (route metadata + item aggregation),
//     stitched in Node — simpler than json_agg and the route count
//     is small (typically 6-12).
//   • All write paths wrapped in pgClient.begin().
// ════════════════════════════════════════════════════════════════════

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pgClient } from "../lib/db.js";
import { adminAuth, requireRole } from "../middleware/admin-auth.js";
import {
  type StockBucket,
  MILK_CURD_CATEGORIES,
  bucketsForRole,
} from "../lib/stock-buckets.js";
import { displayRouteCode } from "../lib/route-code.js";
import { istToday } from "../lib/ist-date.js";

// Statuses that should appear on the loading checklist.
// 'pending' = newly placed, not yet posted to a route assignment.
// 'confirmed' = posted, ready to load.
// 'dispatched' = vehicle has left (kept in view until end-of-day).
const DISPATCHABLE_STATUSES = ["pending", "confirmed", "dispatched"] as const;

// Adhoc sales (direct_sales: cash counter, VIP sample, employee subsidy sold
// before it became a real indent, and route-less agent gate passes) carry a
// NULLABLE route_id — most are handed over at the plant and never named a
// route. The goods still leave FGS, so they are bucketed under this sentinel
// id and shown as one "no route" card rather than dropped off the checklist.
// The nil UUID
// can never collide with a real routes.id (gen_random_uuid never returns it).
const ADHOC_ROUTE_ID = "00000000-0000-0000-0000-000000000000";

export async function dispatchSheetRoutes(app: FastifyInstance) {
  // ════════════════════════════════════════════════════════════════
  // 1. GET /api/v1/dispatch-sheet
  //    ?date=YYYY-MM-DD (required, defaults to today)
  //    ?routeId=uuid    (optional)
  //    ?batchId=uuid    (optional)
  // ════════════════════════════════════════════════════════════════
  app.get(
    "/api/v1/dispatch-sheet",
    { preHandler: [adminAuth, requireRole("distribution.view")] },
    async (request, reply) => {
      const querySchema = z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        routeId: z.string().uuid().optional(),
        batchId: z.string().uuid().optional(),
        bucket: z.enum(["milk-curd", "others"]).optional(),
      });
      const q = querySchema.parse(request.query);

      const targetDate = q.date ?? istToday();
      const routeId = q.routeId ?? null;
      const batchId = q.batchId ?? null;

      // Bucket scoping mirrors inventory.ts: the two FGS diary roles can only
      // ever see their own product bucket — force it, ignoring any wider query
      // param. Unrestricted roles honour the requested bucket (undefined → all).
      // The split-by-category SQL below loads each diary's own dispatch sheet.
      const allowedBuckets = bucketsForRole(request.admin!.role);
      const effectiveBucket: StockBucket | null =
        allowedBuckets.length === 1 ? allowedBuckets[0]! : (q.bucket ?? null);

      // ── Routes that have at least one dispatchable order on this
      // date, with route metadata + per-route totals + assignment
      // status (from route_assignments if it exists, else 'pending').
      //
      // The batch filter is applied via batch_routes (a route may
      // belong to multiple batches; we include the route if ANY of
      // its batches matches the filter).
      const routes = await pgClient`
        WITH route_orders AS (
          -- Joined down to order_items so the bucket filter (by product
          -- category) and the per-route header totals (dealers / items /
          -- amount) all reflect ONLY the products in the requested bucket.
          -- line_total is GST-inclusive (orders.ts), so SUM(line_total) per
          -- order == grand_total — the unbucketed total matches the old query.
          SELECT
            COALESCE(o.route_id, d.route_id) AS route_id,
            COUNT(DISTINCT o.id)::int AS order_count,
            COUNT(oi.id)::int AS line_count,
            COALESCE(SUM(oi.line_total), 0)::numeric AS total_amount
          FROM orders o
          -- No deleted_at / active filter on the dealer: a confirmed order is
          -- goods that must still be loaded and delivered, and deleting or
          -- deactivating the dealer afterwards must never erase it from the
          -- dispatch totals.
          JOIN dealers d        ON d.id = o.dealer_id
          -- Play Store demo route: a reviewer's test activity is not the union's
          -- trade and must never reach this report. Mirrors routes/sales-reports.ts.
          AND NOT EXISTS (SELECT 1 FROM routes demo_rt
                           WHERE demo_rt.code = 'DEMO'
                             AND demo_rt.id = COALESCE(o.route_id, d.route_id))
          JOIN order_items oi   ON oi.order_id = o.id
          JOIN products p       ON p.id = oi.product_id AND p.deleted_at IS NULL
          LEFT JOIN categories c ON c.id = p.category_id
          WHERE o.delivery_date = ${targetDate}::date
            AND o.status::text = ANY(${DISPATCHABLE_STATUSES as unknown as string[]}::text[])
            AND COALESCE(o.route_id, d.route_id) IS NOT NULL
            AND (${routeId}::uuid IS NULL
                 OR COALESCE(o.route_id, d.route_id) = ${routeId ?? '00000000-0000-0000-0000-000000000000'}::uuid)
            AND (${batchId}::uuid IS NULL
                 OR EXISTS (SELECT 1 FROM batch_routes br
                            WHERE br.route_id = COALESCE(o.route_id, d.route_id)
                              AND br.batch_id = ${batchId ?? '00000000-0000-0000-0000-000000000000'}::uuid))
            AND (
              ${effectiveBucket}::text IS NULL
              OR (${effectiveBucket}::text = 'milk-curd' AND LOWER(c.name) = ANY(${MILK_CURD_CATEGORIES}::text[]))
              OR (${effectiveBucket}::text = 'others'    AND LOWER(c.name) <> ALL(${MILK_CURD_CATEGORIES}::text[]))
            )
          GROUP BY COALESCE(o.route_id, d.route_id)
        ),
        -- Employee-subsidy indents ride the same load but live in
        -- employee_orders (orders.dealer_id is NOT NULL, so they cannot sit in
        -- the orders table). Without this branch the loading checklist
        -- silently omitted them and the goods were never put on the truck.
        -- Employee subsidy carries NO route (it is handed over at the plant),
        -- so a route-less indent buckets under the ADHOC sentinel instead of
        -- being dropped.
        employee_route_orders AS (
          SELECT
            COALESCE(eo.route_id, ${ADHOC_ROUTE_ID}::uuid) AS route_id,
            COUNT(DISTINCT eo.id)::int AS order_count,
            COUNT(eoi.id)::int AS line_count,
            COALESCE(SUM(eoi.line_total), 0)::numeric AS total_amount
          FROM employee_orders eo
          JOIN employee_order_items eoi ON eoi.employee_order_id = eo.id
          JOIN products p       ON p.id = eoi.product_id AND p.deleted_at IS NULL
          LEFT JOIN categories c ON c.id = p.category_id
          WHERE eo.delivery_date = ${targetDate}::date
            AND eo.status::text = ANY(${DISPATCHABLE_STATUSES as unknown as string[]}::text[])
            AND (${routeId}::uuid IS NULL OR eo.route_id = ${routeId ?? '00000000-0000-0000-0000-000000000000'}::uuid)
            AND (${batchId}::uuid IS NULL
                 OR EXISTS (SELECT 1 FROM batch_routes br
                            WHERE br.route_id = eo.route_id
                              AND br.batch_id = ${batchId ?? '00000000-0000-0000-0000-000000000000'}::uuid))
            AND (
              ${effectiveBucket}::text IS NULL
              OR (${effectiveBucket}::text = 'milk-curd' AND LOWER(c.name) = ANY(${MILK_CURD_CATEGORIES}::text[]))
              OR (${effectiveBucket}::text = 'others'    AND LOWER(c.name) <> ALL(${MILK_CURD_CATEGORIES}::text[]))
            )
          -- Group on the raw column, NOT on the COALESCE: every interpolation
          -- in this template becomes its own bind placeholder, so repeating
          -- the sentinel here would be a DIFFERENT parameter than the one in
          -- the SELECT ($12 vs $5) and Postgres rejects the select expression
          -- as ungrouped. Selecting COALESCE over a grouped column is valid —
          -- the expression is built only from the grouping key.
          GROUP BY eo.route_id
        ),
        -- Adhoc counter sales: cash sales, VIP samples and the pre-2026-08-02
        -- employee subsidy rows, all in direct_sales. They are goods leaving
        -- FGS on the same day, so the loading checklist has to account for
        -- them. Those naming a route join that route's card; the rest (the
        -- common case — the counter never asks for a route) fall under the
        -- ADHOC sentinel card.
        --
        -- Agent gate passes join only when they named NO route. A ROUTED gate
        -- pass is excluded on purpose: it prints per route on the Gate Pass
        -- Report, and counting it here too would double it against that sheet.
        -- A route-less one prints on neither (the Gate Pass Report joins
        -- routes), so without this branch its packets were invisible to the
        -- loader. The same rule runs on the Route Sheet's ADHOC page, so the
        -- two sheets never disagree on a packet count.
        adhoc_route_orders AS (
          SELECT
            COALESCE(ds.route_id, ${ADHOC_ROUTE_ID}::uuid) AS route_id,
            COUNT(DISTINCT ds.id)::int AS order_count,
            COUNT(dsi.id)::int AS line_count,
            COALESCE(SUM(dsi.line_total), 0)::numeric AS total_amount
          FROM direct_sales ds
          JOIN direct_sale_items dsi ON dsi.direct_sale_id = ds.id
          JOIN products p       ON p.id = dsi.product_id AND p.deleted_at IS NULL
          LEFT JOIN categories c ON c.id = p.category_id
          WHERE ds.sale_date = ${targetDate}::date
            AND ds.status = 'confirmed'
            AND (ds.customer_type IN ('cash', 'vip_sample', 'employee_subsidy')
                 OR (ds.customer_type = 'agent' AND ds.route_id IS NULL))
            AND (${routeId}::uuid IS NULL OR ds.route_id = ${routeId ?? '00000000-0000-0000-0000-000000000000'}::uuid)
            -- A routed sale follows its route's batch membership, exactly like
            -- a dealer order. A route-less sale has no batch to inherit, so it
            -- shows only when it was explicitly tagged with the filtered batch.
            AND (${batchId}::uuid IS NULL
                 OR (ds.route_id IS NOT NULL
                     AND EXISTS (SELECT 1 FROM batch_routes br
                                 WHERE br.route_id = ds.route_id
                                   AND br.batch_id = ${batchId ?? '00000000-0000-0000-0000-000000000000'}::uuid))
                 OR (ds.route_id IS NULL
                     AND ds.batch_id = ${batchId ?? '00000000-0000-0000-0000-000000000000'}::uuid))
            AND (
              ${effectiveBucket}::text IS NULL
              OR (${effectiveBucket}::text = 'milk-curd' AND LOWER(c.name) = ANY(${MILK_CURD_CATEGORIES}::text[]))
              OR (${effectiveBucket}::text = 'others'    AND LOWER(c.name) <> ALL(${MILK_CURD_CATEGORIES}::text[]))
            )
          GROUP BY ds.route_id   -- raw column, see employee_route_orders above
        ),
        -- Dispatch state for the ADHOC bucket. It has no route_assignments row
        -- (the sentinel is not a real route), so the state is derived from the
        -- rows themselves: "done" = already stamped by mark-dispatched, the
        -- rest are still on the floor. The card reads dispatched only once
        -- nothing is left open, so a counter sale booked AFTER the loader
        -- closed the bucket re-opens it — which is right, those are new goods
        -- that still have to go out.
        --
        -- Deliberately unfiltered by route/batch/bucket: this is the state of
        -- the whole bucket, exactly like a route's assignment status, which
        -- also ignores whichever slice of the sheet is on screen.
        adhoc_state AS (
          SELECT
            COUNT(*) FILTER (WHERE NOT done)::int AS open_count,
            COUNT(*) FILTER (WHERE done)::int     AS done_count
          FROM (
            SELECT ds.dispatched_at IS NOT NULL AS done
              FROM direct_sales ds
             WHERE ds.sale_date = ${targetDate}::date
               AND ds.status = 'confirmed'
               AND ds.route_id IS NULL
               -- 'agent' belongs here only because route_id IS NULL above
               -- already limits it to the route-less gate passes this bucket
               -- carries; a routed one stays on the Gate Pass Report.
               AND ds.customer_type IN ('cash', 'vip_sample', 'employee_subsidy', 'agent')
            UNION ALL
            -- Only the statuses mark-dispatched can move. A 'pending' employee
            -- indent is not loadable yet, so counting it as open would hold
            -- the card at pending forever.
            SELECT eo.status::text = 'dispatched'
              FROM employee_orders eo
             WHERE eo.delivery_date = ${targetDate}::date
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
          (r.deleted_at IS NOT NULL) AS "retired",
          ct.name       AS "contractorName",
          COALESCE(ra.vehicle_number, ct.vehicle_number) AS "vehicleNumber",
          ra.driver_name AS "driverName",
          -- Resolved dispatch_time: assignment > batch > route
          COALESCE(ra.departure_time::text,
            r.dispatch_time::text)            AS "dispatchTime",
          -- Real routes read their assignment; the ADHOC bucket has none and
          -- falls through to the derived state above.
          COALESCE(
            ra.status::text,
            CASE WHEN ro.route_id = ${ADHOC_ROUTE_ID}::uuid
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
        -- LEFT so the ADHOC sentinel bucket survives the join; the WHERE below
        -- still drops rows pointing at a route that is missing from the masters.
        --
        -- A soft-deleted route is NOT dropped: the list is built from routes
        -- that actually have orders on the date, and deleting a route today
        -- cannot unmake the load it carried on a past date. Filtering it out
        -- here took the whole page off the sheet, order counts and all.
        LEFT JOIN routes r      ON r.id = ro.route_id
        LEFT JOIN contractors ct ON ct.id = r.contractor_id AND ct.deleted_at IS NULL
        LEFT JOIN route_assignments ra
               ON ra.route_id = r.id AND ra.date = ${targetDate}::date
        -- One unconditional row (aggregate, no GROUP BY), read only by the
        -- sentinel's CASE above; on a real route the COALESCE never reaches it.
        CROSS JOIN adhoc_state ast
        WHERE r.id IS NOT NULL OR ro.route_id = ${ADHOC_ROUTE_ID}::uuid
        -- Live routes first, in code order; deleted ones then the adhoc bucket.
        ORDER BY (r.id IS NULL), (r.deleted_at IS NOT NULL), r.code
      `;

      if (routes.length === 0) {
        return reply.send({
          date: targetDate,
          summary: { totalItems: 0, totalPackets: 0, totalCrates: 0, totalRoutes: 0 },
          routes: [],
        });
      }

      // ── Item-level aggregation per (route, product).
      // Crates/loose math is done in SQL with safe division
      // (packets_crate may be 0 or NULL for some products).
      // Dealer and employee lines are folded into one (route, product) stream
      // BEFORE aggregation, so a product carried by both rails reports a single
      // combined row — and its crates/loose split is computed once from the
      // combined quantity, never rounded per rail and then added up.
      const items = await pgClient`
        WITH dispatch_lines AS (
          SELECT COALESCE(o.route_id, d.route_id) AS route_id,
                 oi.product_id                    AS product_id,
                 oi.quantity                      AS quantity
            FROM orders o
            JOIN dealers d      ON d.id = o.dealer_id
            -- Play Store demo route: a reviewer's test activity is not the union's
            -- trade and must never reach this report. Mirrors routes/sales-reports.ts.
            AND NOT EXISTS (SELECT 1 FROM routes demo_rt
                             WHERE demo_rt.code = 'DEMO'
                               AND demo_rt.id = COALESCE(o.route_id, d.route_id))
            JOIN order_items oi ON oi.order_id = o.id
           WHERE o.delivery_date = ${targetDate}::date
             AND o.status::text = ANY(${DISPATCHABLE_STATUSES as unknown as string[]}::text[])
             AND COALESCE(o.route_id, d.route_id) IS NOT NULL
             AND (${routeId}::uuid IS NULL
                  OR COALESCE(o.route_id, d.route_id) = ${routeId ?? '00000000-0000-0000-0000-000000000000'}::uuid)
             AND (${batchId}::uuid IS NULL
                  OR EXISTS (SELECT 1 FROM batch_routes br
                             WHERE br.route_id = COALESCE(o.route_id, d.route_id)
                               AND br.batch_id = ${batchId ?? '00000000-0000-0000-0000-000000000000'}::uuid))
          UNION ALL
          SELECT COALESCE(eo.route_id, ${ADHOC_ROUTE_ID}::uuid), eoi.product_id, eoi.quantity
            FROM employee_orders eo
            JOIN employee_order_items eoi ON eoi.employee_order_id = eo.id
           WHERE eo.delivery_date = ${targetDate}::date
             AND eo.status::text = ANY(${DISPATCHABLE_STATUSES as unknown as string[]}::text[])
             AND (${routeId}::uuid IS NULL
                  OR eo.route_id = ${routeId ?? '00000000-0000-0000-0000-000000000000'}::uuid)
             AND (${batchId}::uuid IS NULL
                  OR EXISTS (SELECT 1 FROM batch_routes br
                             WHERE br.route_id = eo.route_id
                               AND br.batch_id = ${batchId ?? '00000000-0000-0000-0000-000000000000'}::uuid))
          UNION ALL
          -- Adhoc counter sales — see the routes query above for the batch rule
          -- and for why only ROUTE-LESS agent gate passes come along.
          SELECT COALESCE(ds.route_id, ${ADHOC_ROUTE_ID}::uuid), dsi.product_id, dsi.quantity
            FROM direct_sales ds
            JOIN direct_sale_items dsi ON dsi.direct_sale_id = ds.id
           WHERE ds.sale_date = ${targetDate}::date
             AND ds.status = 'confirmed'
             AND (ds.customer_type IN ('cash', 'vip_sample', 'employee_subsidy')
                  OR (ds.customer_type = 'agent' AND ds.route_id IS NULL))
             AND (${routeId}::uuid IS NULL
                  OR ds.route_id = ${routeId ?? '00000000-0000-0000-0000-000000000000'}::uuid)
             AND (${batchId}::uuid IS NULL
                  OR (ds.route_id IS NOT NULL
                      AND EXISTS (SELECT 1 FROM batch_routes br
                                  WHERE br.route_id = ds.route_id
                                    AND br.batch_id = ${batchId ?? '00000000-0000-0000-0000-000000000000'}::uuid))
                  OR (ds.route_id IS NULL
                      AND ds.batch_id = ${batchId ?? '00000000-0000-0000-0000-000000000000'}::uuid))
        )
        SELECT
          dl.route_id             AS "routeId",
          p.id                    AS "productId",
          COALESCE(p.report_alias, p.name) AS "productName",
          c.name                  AS "category",
          p.unit                  AS "unit",
          p.pack_size             AS "packSize",
          COALESCE(p.packets_crate, 0)::int AS "packetsPerCrate",
          SUM(dl.quantity)::int   AS "totalPackets",
          CASE WHEN COALESCE(p.packets_crate, 0) > 0
            THEN FLOOR(SUM(dl.quantity)::numeric / p.packets_crate)::int
            ELSE 0
          END AS "crates",
          CASE WHEN COALESCE(p.packets_crate, 0) > 0
            THEN (SUM(dl.quantity)::int % p.packets_crate)::int
            ELSE SUM(dl.quantity)::int
          END AS "loosePackets",
          p.sort_order            AS "sortOrder"
        FROM dispatch_lines dl
        JOIN products p       ON p.id = dl.product_id AND p.deleted_at IS NULL
        LEFT JOIN categories c ON c.id = p.category_id
        WHERE (
            ${effectiveBucket}::text IS NULL
            OR (${effectiveBucket}::text = 'milk-curd' AND LOWER(c.name) = ANY(${MILK_CURD_CATEGORIES}::text[]))
            OR (${effectiveBucket}::text = 'others'    AND LOWER(c.name) <> ALL(${MILK_CURD_CATEGORIES}::text[]))
          )
        GROUP BY dl.route_id, p.id, p.report_alias, p.name, c.name,
                 p.unit, p.pack_size, p.packets_crate, p.sort_order
        ORDER BY dl.route_id, p.sort_order, p.name
      `;

      // ── Adhoc breakdown per route: which kind of counter sale contributed
      // the extra packets. Purely informational — the packets are already in
      // the item rows above; this only tells the loader WHY the number moved.
      const adhocRows = await pgClient`
        SELECT COALESCE(ds.route_id, ${ADHOC_ROUTE_ID}::uuid) AS route_id,
               ds.customer_type::text     AS source,
               COUNT(DISTINCT ds.id)::int AS sales,
               SUM(dsi.quantity)::int     AS packets
          FROM direct_sales ds
          JOIN direct_sale_items dsi ON dsi.direct_sale_id = ds.id
          JOIN products p       ON p.id = dsi.product_id AND p.deleted_at IS NULL
          LEFT JOIN categories c ON c.id = p.category_id
         WHERE ds.sale_date = ${targetDate}::date
           AND ds.status = 'confirmed'
           AND (ds.customer_type IN ('cash', 'vip_sample', 'employee_subsidy')
                OR (ds.customer_type = 'agent' AND ds.route_id IS NULL))
           AND (${routeId}::uuid IS NULL
                OR ds.route_id = ${routeId ?? '00000000-0000-0000-0000-000000000000'}::uuid)
           AND (${batchId}::uuid IS NULL
                OR (ds.route_id IS NOT NULL
                    AND EXISTS (SELECT 1 FROM batch_routes br
                                WHERE br.route_id = ds.route_id
                                  AND br.batch_id = ${batchId ?? '00000000-0000-0000-0000-000000000000'}::uuid))
                OR (ds.route_id IS NULL
                    AND ds.batch_id = ${batchId ?? '00000000-0000-0000-0000-000000000000'}::uuid))
           AND (
             ${effectiveBucket}::text IS NULL
             OR (${effectiveBucket}::text = 'milk-curd' AND LOWER(c.name) = ANY(${MILK_CURD_CATEGORIES}::text[]))
             OR (${effectiveBucket}::text = 'others'    AND LOWER(c.name) <> ALL(${MILK_CURD_CATEGORIES}::text[]))
           )
         GROUP BY ds.route_id, ds.customer_type   -- raw column, see above
        UNION ALL
        SELECT COALESCE(eo.route_id, ${ADHOC_ROUTE_ID}::uuid) AS route_id,
               'employee_subsidy'         AS source,
               COUNT(DISTINCT eo.id)::int AS sales,
               SUM(eoi.quantity)::int     AS packets
          FROM employee_orders eo
          JOIN employee_order_items eoi ON eoi.employee_order_id = eo.id
          JOIN products p       ON p.id = eoi.product_id AND p.deleted_at IS NULL
          LEFT JOIN categories c ON c.id = p.category_id
         WHERE eo.delivery_date = ${targetDate}::date
           AND eo.status::text = ANY(${DISPATCHABLE_STATUSES as unknown as string[]}::text[])
           AND (${routeId}::uuid IS NULL
                OR eo.route_id = ${routeId ?? '00000000-0000-0000-0000-000000000000'}::uuid)
           AND (${batchId}::uuid IS NULL
                OR EXISTS (SELECT 1 FROM batch_routes br
                           WHERE br.route_id = eo.route_id
                             AND br.batch_id = ${batchId ?? '00000000-0000-0000-0000-000000000000'}::uuid))
           AND (
             ${effectiveBucket}::text IS NULL
             OR (${effectiveBucket}::text = 'milk-curd' AND LOWER(c.name) = ANY(${MILK_CURD_CATEGORIES}::text[]))
             OR (${effectiveBucket}::text = 'others'    AND LOWER(c.name) <> ALL(${MILK_CURD_CATEGORIES}::text[]))
           )
         GROUP BY eo.route_id   -- raw column, see above
      `;

      // Human labels for the adhoc sources this sheet carries. 'agent' only
      // ever reaches this map from the route-less bucket — see the routes
      // query — so the label says so and the loader is not left wondering
      // where the routed gate passes went.
      const ADHOC_LABELS: Record<string, string> = {
        cash:             "Cash sale",
        vip_sample:       "VIP sample",
        employee_subsidy: "Employee subsidy",
        agent:            "Gate pass (no route)",
      };
      const adhocByRoute = new Map<string, Array<{ source: string; label: string; sales: number; packets: number }>>();
      for (const row of adhocRows as any[]) {
        const list = adhocByRoute.get(row.route_id) ?? [];
        // employee_subsidy can arrive on both rails (employee_orders and the
        // legacy direct_sales rows) — collapse them into one line.
        const existing = list.find(x => x.source === row.source);
        if (existing) {
          existing.sales   += row.sales;
          existing.packets += row.packets;
        } else {
          list.push({
            source:  row.source,
            label:   ADHOC_LABELS[row.source] ?? row.source,
            sales:   row.sales,
            packets: row.packets,
          });
        }
        adhocByRoute.set(row.route_id, list);
      }

      // ── Stitch items into routes + compute per-route totals
      const itemsByRoute = new Map<string, any[]>();
      for (const row of items as any[]) {
        const list = itemsByRoute.get(row.routeId) ?? [];
        list.push({
          productId:       row.productId,
          productName:     row.productName,
          category:        row.category ?? "",
          unit:            row.unit,
          packSize:        row.packSize ? parseFloat(row.packSize) : null,
          totalPackets:    row.totalPackets,
          packetsPerCrate: row.packetsPerCrate,
          crates:          row.crates,
          loosePackets:    row.loosePackets,
        });
        itemsByRoute.set(row.routeId, list);
      }

      const routesOut = (routes as any[]).map(r => {
        const routeItems = itemsByRoute.get(r.routeId) ?? [];
        const packets = routeItems.reduce((s, it) => s + it.totalPackets, 0);
        const crates  = routeItems.reduce((s, it) => s + it.crates, 0);
        return {
          routeId:        r.routeId,
          routeCode:      displayRouteCode(r.routeCode),
          routeName:      r.routeName,
          // The sentinel bucket: adhoc sales that named no route. It is not a
          // real route, so the UI must not offer route actions on it.
          isAdhoc:        r.isAdhoc === true,
          // Deleted from the masters after this date's load went out.
          retired:        r.retired === true,
          adhoc:          adhocByRoute.get(r.routeId) ?? [],
          contractorName: r.contractorName ?? null,
          vehicleNumber:  r.vehicleNumber ?? null,
          driverName:     r.driverName ?? null,
          dispatchTime:   r.dispatchTime ?? null,
          status:         r.status,
          assignmentId:   r.assignmentId ?? null,
          dealerCount:    r.dealerCount,
          lineCount:      r.lineCount,
          totalAmount:    parseFloat(r.totalAmount),
          items:          routeItems,
          totals: { packets, crates },
        };
      });

      const summary = routesOut.reduce(
        (acc, r) => ({
          totalItems:   acc.totalItems   + r.lineCount,
          totalPackets: acc.totalPackets + r.totals.packets,
          totalCrates:  acc.totalCrates  + r.totals.crates,
          totalRoutes:  acc.totalRoutes  + 1,
        }),
        { totalItems: 0, totalPackets: 0, totalCrates: 0, totalRoutes: 0 }
      );

      return reply.send({ date: targetDate, summary, routes: routesOut });
    }
  );

  // ════════════════════════════════════════════════════════════════
  // 2. POST /api/v1/dispatch/create
  //    Body: { date, routeId, batchId?, dispatchTime?, vehicleNumber?,
  //            driverName?, driverPhone?, notes?, indentIds[] }
  // ════════════════════════════════════════════════════════════════
  app.post(
    "/api/v1/dispatch/create",
    { preHandler: [adminAuth, requireRole("distribution.manage")] },
    async (request, reply) => {
      const schema = z.object({
        date:          z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        routeId:       z.string().uuid(),
        batchId:       z.string().uuid().optional().nullable(),
        dispatchTime:  z.string().optional().nullable(),  // "HH:MM" or "HH:MM:SS"
        vehicleNumber: z.string().optional().nullable(),
        driverName:    z.string().optional().nullable(),
        driverPhone:   z.string().optional().nullable(),
        notes:         z.string().optional().nullable(),
        indentIds:     z.array(z.string().uuid()).min(1),
      });
      const body = schema.parse(request.body);

      // Pre-flight: confirm route exists and pull defaults (vehicle from
      // contractor, dispatch_time from batch/route) so the form can be
      // submitted with empty fields.
      const [route] = await pgClient`
        SELECT r.id, r.code, r.name, r.contractor_id,
               r.dispatch_time AS route_dispatch_time,
               ct.vehicle_number AS contractor_vehicle
        FROM routes r
        LEFT JOIN contractors ct ON ct.id = r.contractor_id AND ct.deleted_at IS NULL
        -- A soft-deleted route is still accepted here. Its indents keep showing
        -- on the sheet for the dates they were placed for, and goods already
        -- booked have to be marked out; refusing would strand them as pending
        -- forever with no way to close the day.
        WHERE r.id = ${body.routeId}
        LIMIT 1
      `;
      if (!route) return reply.status(404).send({ error: "Route not found" });

      const resolvedDispatchTime =
        body.dispatchTime ?? route.route_dispatch_time ?? null;
      const resolvedVehicle =
        body.vehicleNumber ?? route.contractor_vehicle ?? null;

      try {
        const result = await pgClient.begin(async (_tx) => {
          const tx = _tx as unknown as typeof pgClient;
          // ── A. UPSERT route_assignments for (route_id, date).
          // No DB-level UNIQUE on (route_id, date), so we use the
          // standard CTE-upsert pattern. Race-safe inside a tx.
          const [assignment] = await tx`
            WITH updated AS (
              UPDATE route_assignments SET
                vehicle_number = COALESCE(${resolvedVehicle}, vehicle_number),
                driver_name    = COALESCE(${body.driverName ?? null}, driver_name),
                driver_phone   = COALESCE(${body.driverPhone ?? null}, driver_phone),
                departure_time = COALESCE(${resolvedDispatchTime}::time, departure_time),
                notes          = COALESCE(${body.notes ?? null}, notes),
                updated_at     = now()
              WHERE route_id = ${body.routeId}::uuid
                AND date     = ${body.date}::date
              RETURNING *
            ),
            inserted AS (
              INSERT INTO route_assignments (
                route_id, date, vehicle_number, driver_name, driver_phone,
                departure_time, notes, status
              )
              SELECT
                ${body.routeId}::uuid,
                ${body.date}::date,
                ${resolvedVehicle},
                ${body.driverName  ?? null},
                ${body.driverPhone ?? null},
                ${resolvedDispatchTime}::time,
                ${body.notes ?? null},
                'pending'::dispatch_status
              WHERE NOT EXISTS (SELECT 1 FROM updated)
              RETURNING *
            )
            SELECT * FROM updated
            UNION ALL
            SELECT * FROM inserted
          `;

          // ── B. Verify selected indents are confirmed and belong to this route.
          // Orders now go directly to 'confirmed' on dealer/auto-confirm — no
          // pending→confirmed transition needed here.
          const confirmed = await tx`
            SELECT o.id, o.item_count, o.grand_total
            FROM orders o
            JOIN dealers d ON o.dealer_id = d.id
            -- Play Store demo route: a reviewer's test activity is not the union's
            -- trade and must never reach this report. Mirrors routes/sales-reports.ts.
            AND NOT EXISTS (SELECT 1 FROM routes demo_rt
                             WHERE demo_rt.code = 'DEMO'
                               AND demo_rt.id = COALESCE(o.route_id, d.route_id))
            WHERE o.id       = ANY(${body.indentIds}::uuid[])
              AND o.status   = 'confirmed'
              AND o.delivery_date = ${body.date}::date
              AND COALESCE(o.route_id, d.route_id) = ${body.routeId}::uuid
          `;

          // ── C. Recompute aggregate counters from authoritative source
          // (all confirmed/dispatched orders for this route+date).
          const [totals] = await tx`
            SELECT
              COUNT(DISTINCT o.id)::int AS dealer_count,
              COALESCE(SUM(o.item_count), 0)::int AS item_count,
              COALESCE(SUM(o.grand_total), 0)::numeric AS total_amount
            FROM orders o
            JOIN dealers d ON d.id = o.dealer_id
            -- Play Store demo route: a reviewer's test activity is not the union's
            -- trade and must never reach this report. Mirrors routes/sales-reports.ts.
            AND NOT EXISTS (SELECT 1 FROM routes demo_rt
                             WHERE demo_rt.code = 'DEMO'
                               AND demo_rt.id = COALESCE(o.route_id, d.route_id))
            WHERE o.delivery_date = ${body.date}::date
              AND COALESCE(o.route_id, d.route_id) = ${body.routeId}::uuid
              AND o.status IN ('confirmed','dispatched','delivered')
          `;

          if (!totals || !assignment) throw new Error("Failed to build dispatch sheet");

          await tx`
            UPDATE route_assignments SET
              dealer_count = ${totals.dealer_count}::int,
              item_count   = ${totals.item_count}::int,
              updated_at   = now()
            WHERE id = ${assignment.id}
          `;

          return {
            assignment,
            confirmedCount: confirmed.length,
            totals: {
              dealerCount: totals.dealer_count,
              itemCount:   totals.item_count,
              totalAmount: parseFloat(totals.total_amount),
            },
          };
        });

        return reply.status(201).send({
          message: `Dispatch created: ${result.confirmedCount} indents posted`,
          ...result,
        });
      } catch (err) {
        request.log.error(err, "Create dispatch failed");
        throw err;
      }
    }
  );

  // ════════════════════════════════════════════════════════════════
  // 3. POST /api/v1/dispatch-sheet/mark-dispatched
  //    Body: { routeId, date }
  //    Cascades confirmed → dispatched, ROUTE-SCOPED
  //    (the existing PATCH /dispatch/assignments/:id cascades zone-
  //     wide which is incorrect — we don't reuse it here).
  // ════════════════════════════════════════════════════════════════
  app.post(
    "/api/v1/dispatch-sheet/mark-dispatched",
    { preHandler: [adminAuth, requireRole("distribution.manage")] },
    async (request, reply) => {
      const schema = z.object({
        routeId: z.string().uuid(),
        date:    z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      });
      const body = schema.parse(request.body);

      // The ADHOC bucket is a real card on the sheet with real goods on it,
      // but it is not a route: there is no route_assignments row to flip
      // (route_id is a FK to routes and the sentinel is not one) and no dealer
      // orders to cascade. Its lines are stamped directly instead.
      const isAdhoc = body.routeId === ADHOC_ROUTE_ID;

      const result = await pgClient.begin(async (_tx) => {
        const tx = _tx as unknown as typeof pgClient;
        // Upsert assignment to dispatched, stamp time-of-day +
        // full timestamp if not already set.
        const [assignment] = isAdhoc ? [null] : await tx`
          WITH updated AS (
            UPDATE route_assignments SET
              status                = 'dispatched',
              departure_time        = COALESCE(departure_time, (now() AT TIME ZONE 'Asia/Kolkata')::time),
              actual_departure_time = COALESCE(actual_departure_time, now()),
              updated_at            = now()
            WHERE route_id = ${body.routeId}::uuid
              AND date     = ${body.date}::date
            RETURNING *
          ),
          inserted AS (
            INSERT INTO route_assignments (
              route_id, date, status, departure_time, actual_departure_time
            )
            SELECT
              ${body.routeId}::uuid,
              ${body.date}::date,
              'dispatched'::dispatch_status,
              (now() AT TIME ZONE 'Asia/Kolkata')::time,
              now()
            WHERE NOT EXISTS (SELECT 1 FROM updated)
            RETURNING *
          )
          SELECT * FROM updated
          UNION ALL
          SELECT * FROM inserted
        `;

        // Route-scoped cascade. Keyed on delivery_date so it matches the
        // orders the dispatch sheet was built from (idx_orders_delivery_date
        // supports the scan). Filtering on created_at here would miss
        // standing-indent orders materialized the night before delivery.
        //
        // The ADHOC bucket holds no dealer orders (orders.dealer_id is NOT
        // NULL and a dealer always resolves to a route), so it skips this.
        const cascaded = isAdhoc ? [] : await tx`
          UPDATE orders o SET
            status         = 'dispatched',
            dispatched_at  = COALESCE(o.dispatched_at, now()),
            updated_at     = now()
          FROM dealers d
          WHERE o.dealer_id = d.id
            AND o.delivery_date = ${body.date}::date
            AND COALESCE(o.route_id, d.route_id) = ${body.routeId}::uuid
            AND o.status   = 'confirmed'
          RETURNING o.id
        `;

        // The other two rails on this card. Both were previously left behind
        // by Mark Dispatched — an employee indent sat at 'confirmed' forever
        // and an adhoc sale had nowhere to record that it had gone out — so
        // they are cascaded here for real routes too, not just the ADHOC
        // bucket. Matching the sheet: route_id IS NULL is the sentinel's
        // membership test, a real id is everyone else's.
        const employeeCascaded = await tx`
          UPDATE employee_orders SET
            status     = 'dispatched',
            updated_at = now()
          WHERE delivery_date = ${body.date}::date
            AND status = 'confirmed'
            AND ((${isAdhoc}::boolean AND route_id IS NULL)
                 OR (NOT ${isAdhoc}::boolean AND route_id = ${body.routeId}::uuid))
          RETURNING id
        `;

        // Adhoc counter sales carry no status, only this timestamp (migration
        // 0066). COALESCE keeps the first stamp: re-marking a route must not
        // rewrite when the goods actually left.
        const adhocCascaded = await tx`
          UPDATE direct_sales SET
            dispatched_at = COALESCE(dispatched_at, now()),
            updated_at    = now()
          WHERE sale_date = ${body.date}::date
            AND status = 'confirmed'
            -- Route-less gate passes ride the ADHOC card, so closing it has to
            -- stamp them too. A ROUTED gate pass is never touched: it is not on
            -- this sheet at all (it prints on the Gate Pass Report), so the
            -- customer_type test pairs with route_id IS NULL.
            AND (customer_type IN ('cash', 'vip_sample', 'employee_subsidy')
                 OR (customer_type = 'agent' AND route_id IS NULL))
            AND dispatched_at IS NULL
            AND ((${isAdhoc}::boolean AND route_id IS NULL)
                 OR (NOT ${isAdhoc}::boolean AND route_id = ${body.routeId}::uuid))
          RETURNING id
        `;

        return {
          assignment,
          dispatchedOrderCount:   cascaded.length,
          employeeIndentCount:    employeeCascaded.length,
          adhocSaleCount:         adhocCascaded.length,
        };
      });

      // The adhoc card has no dealer orders, so quoting an order count there
      // would always read "0 orders" and look like the action did nothing.
      const moved = isAdhoc
        ? [
            result.adhocSaleCount      ? `${result.adhocSaleCount} adhoc sales` : "",
            result.employeeIndentCount ? `${result.employeeIndentCount} employee indents` : "",
          ].filter(Boolean).join(", ") || "nothing left to dispatch"
        : `${result.dispatchedOrderCount} orders cascaded`;

      return reply.send({
        message: isAdhoc
          ? `Adhoc sales marked dispatched: ${moved}`
          : `Route marked dispatched: ${moved}`,
        ...result,
      });
    }
  );
}