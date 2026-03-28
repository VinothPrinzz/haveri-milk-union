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
        SELECT r.id, r.code, r.name, r.stops, r.distance_km, r.active, r.stop_details,
               r.zone_id,
               z.name AS zone_name, z.slug AS zone_slug, z.icon AS zone_icon
        FROM routes r
        JOIN zones z ON z.id = r.zone_id
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
        stopDetails: z.array(stopSchema).optional(),
      });
      const body = schema.parse(request.body);
      const stopDetails = body.stopDetails ?? [];
      const totalDistance = stopDetails.reduce((sum, s) => sum + s.distanceFromPrev, 0);

      // Auto-generate code if not provided
      const code = body.code || `R${Date.now().toString().slice(-4)}`;

      const [route] = await pgClient`
        INSERT INTO routes (code, name, zone_id, stops, distance_km, stop_details)
        VALUES (${code}, ${body.name}, ${body.zoneId}, ${stopDetails.length},
                ${totalDistance.toFixed(1)}::numeric, ${JSON.stringify(stopDetails)}::jsonb)
        RETURNING id, code, name, stops, distance_km, stop_details
      `;
      return reply.status(201).send({ route });
    }
  );

  // PATCH /api/v1/routes/:id — update route including stops
  app.patch(
    "/api/v1/routes/:id",
    { preHandler: [adminAuth, requireRole("distribution.manage")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const schema = z.object({
        name: z.string().optional(),
        code: z.string().optional(),
        active: z.boolean().optional(),
        stopDetails: z.array(stopSchema).optional(),
      });
      const body = schema.parse(request.body);

      if (body.stopDetails) {
        const totalDist = body.stopDetails.reduce((s, st) => s + st.distanceFromPrev, 0);
        await pgClient`
          UPDATE routes SET
            name = COALESCE(${body.name ?? null}, name),
            code = COALESCE(${body.code ?? null}, code),
            active = COALESCE(${body.active ?? null}::boolean, active),
            stop_details = ${JSON.stringify(body.stopDetails)}::jsonb,
            stops = ${body.stopDetails.length},
            distance_km = ${totalDist.toFixed(1)}::numeric,
            updated_at = now()
          WHERE id = ${id} AND deleted_at IS NULL
        `;
      } else {
        await pgClient`
          UPDATE routes SET
            name = COALESCE(${body.name ?? null}, name),
            code = COALESCE(${body.code ?? null}, code),
            active = COALESCE(${body.active ?? null}::boolean, active),
            updated_at = now()
          WHERE id = ${id} AND deleted_at IS NULL
        `;
      }

      const [updated] = await pgClient`SELECT * FROM routes WHERE id = ${id}`;
      if (!updated) return reply.status(404).send({ error: "Route not found" });
      return reply.send({ route: updated });
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
      const targetDate = date ?? new Date().toISOString().split("T")[0];

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
      const targetDate = date ?? new Date().toISOString().split("T")[0];

      const assignments = await pgClient`
        SELECT ra.id, ra.route_id, ra.date, ra.driver_name, ra.vehicle_number,
               ra.departure_time, ra.dealer_count, ra.item_count, ra.status,
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
          SELECT d.name AS dealer_name, o.id AS order_id, o.item_count, o.grand_total,
                 o.status AS order_status
          FROM orders o
          JOIN dealers d ON d.id = o.dealer_id
          WHERE o.zone_id = (SELECT zone_id FROM routes WHERE id = ${a.route_id})
            AND o.created_at::date = ${targetDate}::date
            AND o.status != 'cancelled'
          ORDER BY d.name
        `;
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

  // PATCH /api/v1/dispatch/assignments/:id — update assignment
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
      });
      const body = schema.parse(request.body);

      await pgClient`
        UPDATE route_assignments SET
          vehicle_number = COALESCE(${body.vehicleNumber ?? null}, vehicle_number),
          driver_name = COALESCE(${body.driverName ?? null}, driver_name),
          departure_time = COALESCE(${body.departureTime ?? null}::time, departure_time),
          dealer_count = COALESCE(${body.dealerCount ?? null}::int, dealer_count),
          item_count = COALESCE(${body.itemCount ?? null}::int, item_count),
          updated_at = now()
        WHERE id = ${id}
      `;

      const [updated] = await pgClient`SELECT * FROM route_assignments WHERE id = ${id}`;
      return reply.send({ assignment: updated });
    }
  );
}
