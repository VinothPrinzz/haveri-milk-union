import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, isNull, asc } from "drizzle-orm";
import { db, pgClient } from "../lib/db.js";
import { routes, vehicles, routeAssignments } from "@hmu/db/schema";
import { adminAuth, requireRole } from "../middleware/admin-auth.js";

const stopSchema = z.object({
  name: z.string().min(1),
  distanceFromPrev: z.number().min(0).default(0),
});

export async function distributionRoutes(app: FastifyInstance) {
  // GET /api/v1/routes — all routes with stop details
  app.get(
    "/api/v1/routes",
    { preHandler: [adminAuth, requireRole("distribution.view")] },
    async (request, reply) => {
      const allRoutes = await pgClient`
        SELECT r.id, r.code, r.name, r.stops, r.distance_km, r.active,
               r.zone_id, r.contractor_id, r.primary_batch_id,
               -- Resolved dispatch_time: batch's takes precedence over route's
               COALESCE(b.dispatch_time::text, r.dispatch_time) AS dispatch_time,
               z.name AS zone_name, z.slug AS zone_slug, z.icon AS zone_icon,
               ct.name AS contractor_name,
               b.name AS batch_name,
               b.batch_number AS batch_code,
               (SELECT count(*)::int FROM dealers d
                WHERE d.route_id = r.id AND d.deleted_at IS NULL) AS dealer_count
        FROM routes r
        JOIN zones z ON z.id = r.zone_id
        LEFT JOIN contractors ct ON ct.id = r.contractor_id AND ct.deleted_at IS NULL
        LEFT JOIN batches b ON b.id = r.primary_batch_id AND b.deleted_at IS NULL
        WHERE r.deleted_at IS NULL
        ORDER BY r.code
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
        name: z.string().min(1),
        code: z.string().optional(),
        zoneId: z.string().uuid(),
        contractorId: z.string().uuid().optional(),
        primaryBatchId: z.string().uuid().optional(),
        dispatchTime: z.string().optional(),          // kept for backward compat, no longer required
        stopDetails: z.array(stopSchema).optional(),
        active: z.boolean().optional(),
      });
      const body = schema.parse(request.body);

      // Auto-generate route code if not provided
      let routeCode = body.code;
      if (!routeCode) {
        const [lastRoute] = await pgClient`
          SELECT code FROM routes
          WHERE code ~ '^R[0-9]+$'
          ORDER BY CAST(SUBSTRING(code FROM 2) AS integer) DESC LIMIT 1
          LIMIT 1
        `;
        const lastNum = lastRoute ? parseInt(lastRoute.code.slice(1)) : 0;
        routeCode = `R${lastNum + 1}`;
      }

      const stopDetails = body.stopDetails ?? [];
      const totalDistance = stopDetails.reduce((sum, s) => sum + s.distanceFromPrev, 0);
      const code = routeCode || `R${Date.now().toString().slice(-4)}`;

      const result = await pgClient.begin(async (tx) => {
        const [route] = await tx`
          INSERT INTO routes (
            code, name, zone_id, contractor_id, primary_batch_id,
            dispatch_time, stops, distance_km, stop_details, active
          ) VALUES (
            ${code}, ${body.name}, ${body.zoneId}, ${body.contractorId ?? null},
            ${body.primaryBatchId ?? null}::uuid,
            ${body.dispatchTime ?? null},
            ${stopDetails.length}, ${totalDistance.toFixed(1)}::numeric,
            ${JSON.stringify(stopDetails)}::jsonb,
            ${body.active !== false}
          )
          RETURNING id, code, name, stops, distance_km, stop_details, contractor_id, dispatch_time
        `;

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
        name: z.string().min(1).optional(),
        zoneId: z.string().uuid().optional(),
        contractorId: z.string().uuid().nullable().optional(),
        primaryBatchId: z.string().uuid().nullable().optional(),
        active: z.boolean().optional(),
      });
      const body = schema.parse(request.body);

      const result = await pgClient.begin(async (tx) => {
        const [updated] = await tx`
          UPDATE routes SET
            name = COALESCE(${body.name ?? null}, name),
            zone_id = COALESCE(${body.zoneId ?? null}::uuid, zone_id),
            contractor_id = CASE WHEN ${body.contractorId !== undefined}
                                  THEN ${body.contractorId ?? null}::uuid
                                  ELSE contractor_id END,
            primary_batch_id = CASE WHEN ${body.primaryBatchId !== undefined}
                                     THEN ${body.primaryBatchId ?? null}::uuid
                                     ELSE primary_batch_id END,
            active = COALESCE(${body.active ?? null}::boolean, active),
            updated_at = now()
          WHERE id = ${id} AND deleted_at IS NULL
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

  // DELETE /api/v1/routes/:id (soft delete)
  app.delete(
    "/api/v1/routes/:id",
    { preHandler: [adminAuth, requireRole("distribution.manage")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await pgClient`
        UPDATE routes SET deleted_at = now() WHERE id = ${id} AND deleted_at IS NULL
      `;
      // Also detach dealers so they don't point to a deleted route
      await pgClient`
        UPDATE dealers SET route_id = NULL WHERE route_id = ${id}
      `;
      return reply.send({ message: "Route deleted" });
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
               z.name AS zone_name,
               COALESCE(v.number, ra.vehicle_number) AS vehicle_number
        FROM route_assignments ra
        JOIN routes r ON r.id = ra.route_id
        JOIN zones z ON z.id = r.zone_id
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
               r.name AS route_name, r.code AS route_code, r.stop_details,
               z.name AS zone_name
        FROM route_assignments ra
        JOIN routes r ON r.id = ra.route_id
        JOIN zones z ON z.id = r.zone_id
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
          WHERE o.zone_id = (SELECT zone_id FROM routes WHERE id = ${a.route_id})
            AND o.created_at::date = ${targetDate}::date
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
        SELECT ra.route_id, ra.date, r.zone_id
        FROM route_assignments ra
        JOIN routes r ON r.id = ra.route_id
        WHERE ra.id = ${id}
      `;
      if (!existing) return reply.status(404).send({ error: "Assignment not found" });
      await pgClient.begin(async (tx) => {
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
        if (goingToDispatched) {
          await tx`
            UPDATE orders SET
              status = 'dispatched',
              dispatched_at = now(),
              updated_at = now()
            WHERE zone_id = ${existing.zone_id}
              AND created_at::date = ${existing.date}::date
              AND status = 'confirmed'
          `;
        } else if (goingToDelivered) {
          await tx`
            UPDATE orders SET
              status = 'delivered',
              delivered_at = now(),
              updated_at = now()
            WHERE zone_id = ${existing.zone_id}
              AND created_at::date = ${existing.date}::date
              AND status = 'dispatched'
          `;
        }
      });
      const [updated] = await pgClient`SELECT * FROM route_assignments WHERE id = ${id}`;
      return reply.send({ assignment: updated });
    }
  );
}
