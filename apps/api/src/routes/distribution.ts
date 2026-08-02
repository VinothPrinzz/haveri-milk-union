import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { isNull, asc } from "drizzle-orm";
import { db, pgClient } from "../lib/db.js";
import { vehicles } from "@hmu/db/schema";
import { adminAuth, requireRole } from "../middleware/admin-auth.js";

export async function distributionRoutes(app: FastifyInstance) {
  // GET /api/v1/routes — all routes with stop details
  app.get(
    "/api/v1/routes",
    // routes.view, not distribution.view: this is the route-master lookup that
    // feeds filter dropdowns in other modules (Finance included).
    { preHandler: [adminAuth, requireRole("routes.view")] },
    async (request, reply) => {
      const allRoutes = await pgClient`
        SELECT r.id, r.code, r.name, r.stops, r.distance_km, r.active,
               r.contractor_id, r.primary_batch_id,
               r.rate_per_trip, r.total_km_per_day,
               r.dispatch_time::text AS dispatch_time,
               ct.name AS contractor_name, 
               b.name AS batch_name,
               b.batch_number AS batch_code,
               (SELECT count(*)::int FROM dealers d
                WHERE d.route_id = r.id AND d.deleted_at IS NULL) AS dealer_count
        FROM routes r
        LEFT JOIN contractors ct ON ct.id = r.contractor_id AND ct.deleted_at IS NULL
        LEFT JOIN batches b ON b.id = r.primary_batch_id AND b.deleted_at IS NULL
        WHERE r.deleted_at IS NULL
        ORDER BY
          CASE WHEN r.code ~ '^R[0-9]+$'
               THEN CAST(SUBSTRING(r.code FROM 2) AS integer)
               ELSE 99999 END,
          r.code
      `;
      return reply.send({ routes: allRoutes });
    }
  );

  // POST /api/v1/routes — create route with stop details
  app.post(
    "/api/v1/routes",
    { preHandler: [adminAuth, requireRole("distribution.manage")] },
    async (request, reply) => {
      const schema = z.object({
        name:           z.string().min(1),
        code:           z.string().optional(),
        contractorId:   z.string().uuid().optional(),
        primaryBatchId: z.string().uuid().optional(),
        active:         z.boolean().optional(),
        dispatchTime:   z.string().regex(/^\d{2}:\d{2}$/).optional().nullable(),  // "HH:MM"
        stopDetails:    z.array(z.any()).optional(),
      });
      const body = schema.parse(request.body);

      // Auto-generate route code if not provided
      let routeCode = body.code;
      if (!routeCode) {
        const [lastRoute] = await pgClient`
          SELECT code FROM routes
          WHERE code ~ '^R[0-9]+$'
          ORDER BY CAST(SUBSTRING(code FROM 2) AS integer) DESC
          LIMIT 1
        `;
        const lastNum = lastRoute ? parseInt(lastRoute.code.slice(1)) : 0;
        routeCode = `R${lastNum + 1}`;
      }

      const stopDetails = body.stopDetails ?? [];
      const totalDistance = stopDetails.reduce((sum, s) => sum + s.distanceFromPrev, 0);
      const code = routeCode || `R${Date.now().toString().slice(-4)}`;

      const result = await pgClient.begin(async (_tx) => {
        const tx = _tx as unknown as typeof pgClient;
        const [route] = await tx`
          INSERT INTO routes (
            code, name,
            contractor_id, primary_batch_id,
            dispatch_time,
            stops, distance_km, stop_details,
            active
          )
          VALUES (
            ${code}, ${body.name},
            ${body.contractorId ?? null}::uuid,
            ${body.primaryBatchId ?? null}::uuid,
            ${body.dispatchTime ?? null}::time,
            ${stopDetails.length}, ${totalDistance.toFixed(1)}::numeric,
            ${JSON.stringify(stopDetails)}::jsonb,
            ${body.active !== false}
          )
          RETURNING id, code, name, stops, distance_km, stop_details,
                    contractor_id, primary_batch_id, dispatch_time
        `;

        if (!route) throw new Error("Failed to create route");

        // Ensure batch_routes junction exists if primaryBatchId is provided
        if (body.primaryBatchId) {
          await tx`
            INSERT INTO batch_routes (batch_id, route_id)
            VALUES (${body.primaryBatchId}::uuid, ${route.id}::uuid)
            ON CONFLICT (batch_id, route_id) DO NOTHING
          `;
        }

        return route;
      });

      return reply.status(201).send({ route: result });
    }
  );

  // PATCH /api/v1/routes/:id
  app.patch(
    "/api/v1/routes/:id",
    { preHandler: [adminAuth, requireRole("distribution.manage")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const schema = z.object({
        name:           z.string().min(1).optional(),
        contractorId:   z.string().uuid().nullable().optional(),
        primaryBatchId: z.string().uuid().nullable().optional(),
        active:         z.boolean().optional(),
        dispatchTime:   z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
      });
      const body = schema.parse(request.body);

      const result = await pgClient.begin(async (_tx) => {
        const tx = _tx as unknown as typeof pgClient;
        const [updated] = await tx`
          UPDATE routes SET
            name = COALESCE(${body.name ?? null}, name),
            contractor_id = CASE WHEN ${body.contractorId !== undefined}
                                  THEN ${body.contractorId ?? null}::uuid
                                  ELSE contractor_id END,
            primary_batch_id = CASE WHEN ${body.primaryBatchId !== undefined}
                                    THEN ${body.primaryBatchId ?? null}::uuid
                                    ELSE primary_batch_id END,
            dispatch_time = CASE WHEN ${body.dispatchTime !== undefined}
                                  THEN ${body.dispatchTime ?? null}::time
                                  ELSE dispatch_time END,
            active = COALESCE(${body.active ?? null}::boolean, active),
            updated_at = now()
          WHERE id = ${id}
          RETURNING *
        `;
        if (!updated) return null;

        // Sync batch_routes junction when primary batch changes
        if (body.primaryBatchId !== undefined) {
          if (body.primaryBatchId) {
            await tx`
              INSERT INTO batch_routes (batch_id, route_id)
              VALUES (${body.primaryBatchId}::uuid, ${id}::uuid)
              ON CONFLICT (batch_id, route_id) DO NOTHING
            `;
          }
        }
        return updated;
      });

      if (!result) return reply.status(404).send({ error: "Route not found" });
      return reply.send({ route: result });
    }
  );

  // DELETE /api/v1/routes/:id — soft delete + renumber remaining R-codes
  app.delete(
    "/api/v1/routes/:id",
    { preHandler: [adminAuth, requireRole("distribution.manage")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      await pgClient.begin(async (_tx) => {
        const tx = _tx as unknown as typeof pgClient;

        // Fetch the route before deleting so we know its code
        const [route] = await tx`
          SELECT code FROM routes WHERE id = ${id} AND deleted_at IS NULL
        `;
        if (!route) return; // already gone

        // Rename to a temp code first so the R<N> slot becomes available for
        // renumbering without hitting the unique constraint
        await tx`
          UPDATE routes
          SET code = ${"__DEL_" + id.slice(0, 8)}, deleted_at = now()
          WHERE id = ${id}
        `;

        // Detach dealers pointing to this route
        await tx`UPDATE dealers SET route_id = NULL WHERE route_id = ${id}`;

        // Renumber only when the deleted code is a standard R<N> code
        if (/^R\d+$/.test(route.code)) {
          const deletedNum = parseInt(route.code.slice(1));

          // Fetch all routes that need to shift down, in ascending order
          const toRenumber = await tx`
            SELECT id, code
            FROM routes
            WHERE deleted_at IS NULL
              AND code ~ '^R[0-9]+$'
              AND CAST(SUBSTRING(code FROM 2) AS integer) > ${deletedNum}
            ORDER BY CAST(SUBSTRING(code FROM 2) AS integer) ASC
          `;

          // Process ascending: each step frees the slot below before the next
          for (const r of toRenumber) {
            const newCode = `R${parseInt(r.code.slice(1)) - 1}`;
            await tx`
              UPDATE routes SET code = ${newCode}, updated_at = now()
              WHERE id = ${r.id}
            `;
          }
        }
      });

      return reply.send({ message: "Route deleted" });
    }
  );

  // PATCH /api/v1/routes/:routeId/dealer-positions
  // Body: { positions: [{ dealerId, position }, ...] }
  // Rewrites positions for the given dealers on this route in a single tx.
  app.patch(
    "/api/v1/routes/:routeId/dealer-positions",
    { preHandler: [adminAuth, requireRole("distribution.manage")] },
    async (request, reply) => {
      const { routeId } = request.params as { routeId: string };
      const schema = z.object({
        positions: z.array(z.object({
          dealerId: z.string().uuid(),
          position: z.number().int().min(1),
        })).min(1).max(2000),
      });
      const body = schema.parse(request.body);

      await pgClient.begin(async (_tx) => {
        const tx = _tx as unknown as typeof pgClient;
        // Unnest arrays for a single round-trip update.
        const dealerIds = body.positions.map(p => p.dealerId);
        const positions = body.positions.map(p => p.position);
        await tx`
          UPDATE dealer_routes dr
            SET position = v.position
            FROM (
              SELECT UNNEST(${dealerIds}::uuid[]) AS dealer_id,
                    UNNEST(${positions}::int[])  AS position
            ) v
          WHERE dr.route_id  = ${routeId}::uuid
            AND dr.dealer_id = v.dealer_id
        `;
      });

      // Return the new ordered list for the route
      const rows = await pgClient`
        SELECT d.id, d.code, d.name, dr.position, dr.is_primary
          FROM dealer_routes dr
          JOIN dealers d ON d.id = dr.dealer_id AND d.deleted_at IS NULL
        WHERE dr.route_id = ${routeId}::uuid
        ORDER BY dr.position NULLS LAST, d.code, d.name
      `;
      return reply.send({ routeId, dealers: rows });
    }
  );

  // GET /api/v1/vehicles
  app.get(
    "/api/v1/vehicles",
    { preHandler: [adminAuth, requireRole("distribution.view")] },
    async (request, reply) => {
      const allVehicles = await db.select().from(vehicles).where(isNull(vehicles.deletedAt)).orderBy(asc(vehicles.number));
      return reply.send({ vehicles: allVehicles });
    }
  );

  // GET /api/v1/dispatch/daily
  app.get(
    "/api/v1/dispatch/daily",
    { preHandler: [adminAuth, requireRole("distribution.view")] },
    async (request, reply) => {
      const querySchema = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });
      const { date } = querySchema.parse(request.query);
      const targetDate = date ?? new Date().toISOString().slice(0, 10);
      const assignments = await pgClient`
        SELECT ra.id, ra.date, ra.driver_name, ra.driver_phone,
               ra.departure_time, ra.actual_departure_time,
               ra.dealer_count, ra.item_count, ra.status, ra.notes,
               ra.vehicle_number,
               r.code AS route_code, r.name AS route_name,
               COALESCE(v.number, ra.vehicle_number) AS vehicle_number
        FROM route_assignments ra
        JOIN routes r ON r.id = ra.route_id
        LEFT JOIN vehicles v ON v.id = ra.vehicle_id
        WHERE ra.date = ${targetDate}::date
        ORDER BY ra.departure_time
      `;
      return reply.send({ date: targetDate, assignments, totalRoutes: assignments.length });
    }
  );

  // GET /api/v1/dispatch/assignments — all assignments (for assignments page)
  app.get(
    "/api/v1/dispatch/assignments",
    { preHandler: [adminAuth, requireRole("distribution.view")] },
    async (request, reply) => {
      const querySchema = z.object({ date: z.string().optional() });
      const { date } = querySchema.parse(request.query);
      const targetDate = date ?? new Date().toISOString().slice(0, 10);
      const assignments = await pgClient`
        SELECT ra.id, ra.route_id, ra.date, ra.driver_name, ra.vehicle_number,
               ra.departure_time, ra.actual_departure_time,
               ra.dealer_count, ra.item_count, ra.status,
               r.name AS route_name, r.code AS route_code, r.stop_details
        FROM route_assignments ra
        JOIN routes r ON r.id = ra.route_id
        WHERE ra.date = ${targetDate}::date
        ORDER BY r.code
      `;
      // For each assignment, get the dealers in that zone who have orders for this date
      for (const a of assignments) {
        const dealerOrders = await pgClient`
          SELECT d.name AS dealer_name, d.phone AS dealer_phone, o.id AS order_id,
                 o.item_count, o.grand_total, o.status AS order_status
          FROM orders o
          JOIN dealers d ON d.id = o.dealer_id
          WHERE COALESCE(o.route_id, d.route_id) = ${a.route_id}::uuid
            AND o.delivery_date = ${targetDate}::date
            AND o.status != 'cancelled'
          ORDER BY d.name
        `;
        // Fetch items for each dealer's order
        for (const dOrder of dealerOrders) {
          const items = await pgClient`
            SELECT product_name, quantity, unit_price, line_total
            FROM order_items WHERE order_id = ${dOrder.order_id} ORDER BY product_name
          `;
          (dOrder as any).items = items;
        }
        (a as any).dealers = dealerOrders;
      }
      return reply.send({ data: assignments });
    }
  );

  // POST /api/v1/dispatch/assign
  app.post(
    "/api/v1/dispatch/assign",
    { preHandler: [adminAuth, requireRole("distribution.manage")] },
    async (request, reply) => {
      const schema = z.object({
        routeId: z.string().uuid(),
        vehicleId: z.string().uuid().optional(),
        vehicleNumber: z.string().optional(),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        driverName: z.string().optional(),
        driverPhone: z.string().optional(),
        departureTime: z.string().optional(),
        dealerCount: z.number().int().optional(),
        itemCount: z.number().int().optional(),
      });
      const body = schema.parse(request.body);
      const [assignment] = await pgClient`
        INSERT INTO route_assignments (route_id, vehicle_id, vehicle_number, date, driver_name, driver_phone,
          departure_time, dealer_count, item_count)
        VALUES (${body.routeId}, ${body.vehicleId ?? null}, ${body.vehicleNumber ?? null},
          ${body.date}::date, ${body.driverName ?? null}, ${body.driverPhone ?? null},
          ${body.departureTime ?? null}::time, ${body.dealerCount ?? 0}, ${body.itemCount ?? 0})
        RETURNING *
      `;
      return reply.status(201).send({ assignment });
    }
  );

  // PATCH /api/v1/dispatch/assignments/:id — update assignment + cascade to orders
  app.patch(
    "/api/v1/dispatch/assignments/:id",
    { preHandler: [adminAuth, requireRole("distribution.manage")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const schema = z.object({
        vehicleNumber: z.string().optional(),
        driverName: z.string().optional(),
        driverPhone: z.string().optional(),
        departureTime: z.string().optional(),
        dealerCount: z.number().int().optional(),
        itemCount: z.number().int().optional(),
        status: z.enum(["pending", "loading", "dispatched", "delivered"]).optional(),
        actualDepartureTime: z.string().optional(), // ISO-8601; loose validation for older Zod
      });
      const body = schema.parse(request.body);
      const goingToDispatched = body.status === "dispatched";
      const goingToDelivered = body.status === "delivered";
      // Look up route_id + date so we can cascade to the orders on that route/date.
      const [existing] = await pgClient`
        SELECT ra.route_id, ra.date
        FROM route_assignments ra
        WHERE ra.id = ${id}
      `;
      if (!existing) return reply.status(404).send({ error: "Assignment not found" });
      await pgClient.begin(async (_tx) => {
        const tx = _tx as unknown as typeof pgClient;
        // Update the assignment. If transitioning to dispatched without an explicit time,
        // stamp BOTH departure_time (time-of-day) and actual_departure_time (full timestamp).
        await tx`
          UPDATE route_assignments SET
            vehicle_number = COALESCE(${body.vehicleNumber ?? null}, vehicle_number),
            driver_name = COALESCE(${body.driverName ?? null}, driver_name),
            driver_phone = COALESCE(${body.driverPhone ?? null}, driver_phone),
            departure_time = CASE
              WHEN ${body.departureTime ?? null}::time IS NOT NULL THEN ${body.departureTime ?? null}::time
              WHEN ${goingToDispatched}::boolean AND departure_time IS NULL THEN (now() AT TIME ZONE 'Asia/Kolkata')::time
              ELSE departure_time
            END,
            actual_departure_time = CASE
              WHEN ${body.actualDepartureTime ?? null}::timestamptz IS NOT NULL
                THEN ${body.actualDepartureTime ?? null}::timestamptz
              WHEN ${goingToDispatched}::boolean AND actual_departure_time IS NULL THEN now()
              ELSE actual_departure_time
            END,
            dealer_count = COALESCE(${body.dealerCount ?? null}::int, dealer_count),
            item_count = COALESCE(${body.itemCount ?? null}::int, item_count),
            status = COALESCE(${body.status ?? null}::dispatch_status, status),
            updated_at = now()
          WHERE id = ${id}
        `;
        // Cascade to child orders when the assignment goes dispatched/delivered.
        // The dealer join resolves the order's route only — it must NOT filter
        // on d.deleted_at / d.active, or a dealer deleted after placing an
        // order would leave that order stuck at 'confirmed' forever, dropping
        // it out of every delivered-status report.
        if (goingToDispatched) {
          await tx`
            UPDATE orders o SET
              status = 'dispatched',
              dispatched_at = now(),
              updated_at = now()
            FROM dealers d
            WHERE o.dealer_id = d.id
              AND COALESCE(o.route_id, d.route_id) = ${existing.route_id}::uuid
              AND o.created_at::date = ${existing.date}::date
              AND o.status = 'confirmed'
          `;
        } else if (goingToDelivered) {
          await tx`
            UPDATE orders o SET
              status = 'delivered',
              delivered_at = now(),
              updated_at = now()
            FROM dealers d
            WHERE o.dealer_id = d.id
              AND COALESCE(o.route_id, d.route_id) = ${existing.route_id}::uuid
              AND o.created_at::date = ${existing.date}::date
              AND o.status = 'dispatched'
          `;
        }
      });
      const [updated] = await pgClient`SELECT * FROM route_assignments WHERE id = ${id}`;
      return reply.send({ assignment: updated });
    }
  );
}
