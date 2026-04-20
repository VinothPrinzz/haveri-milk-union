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
//      cascades zone-wide; we don't reuse it).
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

// Statuses that should appear on the loading checklist.
// 'pending' = newly placed, not yet posted to a route assignment.
// 'confirmed' = posted, ready to load.
// 'dispatched' = vehicle has left (kept in view until end-of-day).
const DISPATCHABLE_STATUSES = ["pending", "confirmed", "dispatched"] as const;

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
      });
      const q = querySchema.parse(request.query);

      const targetDate = q.date ?? new Date().toISOString().slice(0, 10);
      const routeId = q.routeId ?? null;
      const batchId = q.batchId ?? null;

      // ── Routes that have at least one dispatchable order on this
      // date, with route metadata + per-route totals + assignment
      // status (from route_assignments if it exists, else 'pending').
      //
      // The batch filter is applied via batch_routes (a route may
      // belong to multiple batches; we include the route if ANY of
      // its batches matches the filter).
      const routes = await pgClient`
        WITH route_orders AS (
          SELECT
            d.route_id,
            COUNT(DISTINCT o.id)::int AS order_count,
            COALESCE(SUM(o.item_count), 0)::int AS line_count,
            COALESCE(SUM(o.grand_total), 0)::numeric AS total_amount
          FROM orders o
          JOIN dealers d ON d.id = o.dealer_id AND d.deleted_at IS NULL
          WHERE o.created_at::date = ${targetDate}::date
            AND o.status::text = ANY(${DISPATCHABLE_STATUSES as unknown as string[]}::text[])
            AND d.route_id IS NOT NULL
            AND (${routeId}::uuid IS NULL
                 OR d.route_id = ${routeId ?? '00000000-0000-0000-0000-000000000000'}::uuid)
            AND (${batchId}::uuid IS NULL
                 OR EXISTS (SELECT 1 FROM batch_routes br
                            WHERE br.route_id = d.route_id
                              AND br.batch_id = ${batchId ?? '00000000-0000-0000-0000-000000000000'}::uuid))
          GROUP BY d.route_id
        )
        SELECT
          r.id          AS "routeId",
          r.code        AS "routeCode",
          r.name        AS "routeName",
          ct.name       AS "contractorName",
          COALESCE(ra.vehicle_number, ct.vehicle_number) AS "vehicleNumber",
          ra.driver_name AS "driverName",
          -- Resolved dispatch_time: assignment > batch > route
          COALESCE(ra.departure_time::text,
                   b.dispatch_time::text,
                   r.dispatch_time)            AS "dispatchTime",
          COALESCE(ra.status::text, 'pending') AS "status",
          ra.id         AS "assignmentId",
          ro.order_count   AS "dealerCount",
          ro.line_count    AS "lineCount",
          ro.total_amount  AS "totalAmount"
        FROM route_orders ro
        JOIN routes r           ON r.id = ro.route_id AND r.deleted_at IS NULL
        LEFT JOIN contractors ct ON ct.id = r.contractor_id AND ct.deleted_at IS NULL
        LEFT JOIN batches b      ON b.id = r.primary_batch_id AND b.deleted_at IS NULL
        LEFT JOIN route_assignments ra
               ON ra.route_id = r.id AND ra.date = ${targetDate}::date
        ORDER BY r.code
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
      const items = await pgClient`
        SELECT
          d.route_id              AS "routeId",
          p.id                    AS "productId",
          COALESCE(p.report_alias, p.name) AS "productName",
          c.name                  AS "category",
          p.unit                  AS "unit",
          p.pack_size             AS "packSize",
          COALESCE(p.packets_crate, 0)::int AS "packetsPerCrate",
          SUM(oi.quantity)::int   AS "totalPackets",
          CASE WHEN COALESCE(p.packets_crate, 0) > 0
            THEN FLOOR(SUM(oi.quantity)::numeric / p.packets_crate)::int
            ELSE 0
          END AS "crates",
          CASE WHEN COALESCE(p.packets_crate, 0) > 0
            THEN (SUM(oi.quantity)::int % p.packets_crate)::int
            ELSE SUM(oi.quantity)::int
          END AS "loosePackets",
          p.sort_order            AS "sortOrder"
        FROM orders o
        JOIN dealers d        ON d.id = o.dealer_id AND d.deleted_at IS NULL
        JOIN order_items oi   ON oi.order_id = o.id
        JOIN products p       ON p.id = oi.product_id AND p.deleted_at IS NULL
        LEFT JOIN categories c ON c.id = p.category_id
        WHERE o.created_at::date = ${targetDate}::date
          AND o.status::text = ANY(${DISPATCHABLE_STATUSES as unknown as string[]}::text[])
          AND d.route_id IS NOT NULL
          AND (${routeId}::uuid IS NULL
               OR d.route_id = ${routeId ?? '00000000-0000-0000-0000-000000000000'}::uuid)
          AND (${batchId}::uuid IS NULL
               OR EXISTS (SELECT 1 FROM batch_routes br
                          WHERE br.route_id = d.route_id
                            AND br.batch_id = ${batchId ?? '00000000-0000-0000-0000-000000000000'}::uuid))
        GROUP BY d.route_id, p.id, p.report_alias, p.name, c.name,
                 p.unit, p.pack_size, p.packets_crate, p.sort_order
        ORDER BY d.route_id, p.sort_order, p.name
      `;

      // ── Stitch items into routes + compute per-route totals
      const itemsByRoute = new Map<string, any[]>();
      for (const row of items as any[]) {
        const list = itemsByRoute.get(row.routeId) ?? [];
        list.push({
          productId:       row.productId,
          productName:     row.productName,
          category:        row.category ?? "—",
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
          routeCode:      r.routeCode,
          routeName:      r.routeName,
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
        SELECT r.id, r.code, r.name, r.zone_id, r.contractor_id,
               r.dispatch_time AS route_dispatch_time,
               ct.vehicle_number AS contractor_vehicle,
               b.dispatch_time::text AS batch_dispatch_time
        FROM routes r
        LEFT JOIN contractors ct ON ct.id = r.contractor_id AND ct.deleted_at IS NULL
        LEFT JOIN batches b      ON b.id = ${body.batchId ?? null}::uuid AND b.deleted_at IS NULL
        WHERE r.id = ${body.routeId} AND r.deleted_at IS NULL
        LIMIT 1
      `;
      if (!route) return reply.status(404).send({ error: "Route not found" });

      const resolvedDispatchTime =
        body.dispatchTime ?? route.batch_dispatch_time ?? route.route_dispatch_time ?? null;
      const resolvedVehicle =
        body.vehicleNumber ?? route.contractor_vehicle ?? null;

      try {
        const result = await pgClient.begin(async (tx) => {
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

          // ── B. Move selected indents pending → confirmed.
          // Guard with status='pending' so we don't accidentally
          // re-confirm an already-dispatched order.
          const confirmed = await tx`
            UPDATE orders o SET
              status       = 'confirmed',
              confirmed_at = now(),
              updated_at   = now()
            FROM dealers d
            WHERE o.dealer_id = d.id
              AND o.id       = ANY(${body.indentIds}::uuid[])
              AND o.status   = 'pending'
              AND o.created_at::date = ${body.date}::date
              AND d.route_id = ${body.routeId}::uuid
            RETURNING o.id, o.item_count, o.grand_total
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
            WHERE o.created_at::date = ${body.date}::date
              AND d.route_id = ${body.routeId}::uuid
              AND o.status IN ('confirmed','dispatched','delivered')
          `;

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
          message: `Dispatch created — ${result.confirmedCount} indents posted`,
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

      const result = await pgClient.begin(async (tx) => {
        // Upsert assignment to dispatched, stamp time-of-day +
        // full timestamp if not already set.
        const [assignment] = await tx`
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

        // Route-scoped cascade. orders is partitioned by created_at,
        // so the date filter prunes partitions correctly.
        const cascaded = await tx`
          UPDATE orders o SET
            status         = 'dispatched',
            dispatched_at  = COALESCE(o.dispatched_at, now()),
            updated_at     = now()
          FROM dealers d
          WHERE o.dealer_id = d.id
            AND o.created_at::date = ${body.date}::date
            AND d.route_id = ${body.routeId}::uuid
            AND o.status   = 'confirmed'
          RETURNING o.id
        `;

        return { assignment, dispatchedOrderCount: cascaded.length };
      });

      return reply.send({
        message: `Route marked dispatched — ${result.dispatchedOrderCount} orders cascaded`,
        ...result,
      });
    }
  );
}