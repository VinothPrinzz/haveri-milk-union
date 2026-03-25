import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, isNull, asc, and, sql } from "drizzle-orm";
import { db, pgClient } from "../lib/db.js";
import { routes, vehicles, routeAssignments, zones } from "@hmu/db/schema";
import { adminAuth, requireRole } from "../middleware/admin-auth.js";

export async function distributionRoutes(app: FastifyInstance) {
  // GET /api/v1/routes — all routes
  app.get(
    "/api/v1/routes",
    { preHandler: [adminAuth, requireRole("distribution.view")] },
    async (request, reply) => {
      const allRoutes = await pgClient`
        SELECT r.id, r.code, r.name, r.stops, r.distance_km, r.active,
               z.name AS zone_name, z.slug AS zone_slug, z.icon AS zone_icon
        FROM routes r
        JOIN zones z ON z.id = r.zone_id
        WHERE r.deleted_at IS NULL
        ORDER BY r.code
      `;

      return reply.status(200).send({ routes: allRoutes });
    }
  );

  // POST /api/v1/routes — create route
  app.post(
    "/api/v1/routes",
    { preHandler: [adminAuth, requireRole("distribution.manage")] },
    async (request, reply) => {
      const schema = z.object({
        code: z.string().min(1),
        name: z.string().min(1),
        zoneId: z.string().uuid(),
        stops: z.number().int().min(0).default(0),
        distanceKm: z.string().optional(),
      });
      const body = schema.parse(request.body);

      const [route] = await db.insert(routes).values(body).returning();
      return reply.status(201).send({ route });
    }
  );

  // GET /api/v1/vehicles — all vehicles
  app.get(
    "/api/v1/vehicles",
    { preHandler: [adminAuth, requireRole("distribution.view")] },
    async (request, reply) => {
      const allVehicles = await db
        .select()
        .from(vehicles)
        .where(isNull(vehicles.deletedAt))
        .orderBy(asc(vehicles.number));

      return reply.status(200).send({ vehicles: allVehicles });
    }
  );

  // GET /api/v1/dispatch/daily — daily dispatch sheet for a given date
  app.get(
    "/api/v1/dispatch/daily",
    { preHandler: [adminAuth, requireRole("distribution.view")] },
    async (request, reply) => {
      const querySchema = z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      });
      const { date } = querySchema.parse(request.query);
      const targetDate = date ?? new Date().toISOString().split("T")[0];

      const assignments = await pgClient`
        SELECT ra.id, ra.date, ra.driver_name, ra.driver_phone,
               ra.departure_time, ra.actual_departure_time,
               ra.dealer_count, ra.item_count, ra.status, ra.notes,
               r.code AS route_code, r.name AS route_name,
               z.name AS zone_name,
               v.number AS vehicle_number
        FROM route_assignments ra
        JOIN routes r ON r.id = ra.route_id
        JOIN zones z ON z.id = r.zone_id
        LEFT JOIN vehicles v ON v.id = ra.vehicle_id
        WHERE ra.date = ${targetDate}::date
        ORDER BY ra.departure_time
      `;

      return reply.status(200).send({
        date: targetDate,
        assignments,
        totalRoutes: assignments.length,
      });
    }
  );

  // POST /api/v1/dispatch/assign — create/update daily route assignment
  app.post(
    "/api/v1/dispatch/assign",
    { preHandler: [adminAuth, requireRole("distribution.manage")] },
    async (request, reply) => {
      const schema = z.object({
        routeId: z.string().uuid(),
        vehicleId: z.string().uuid().optional(),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        driverName: z.string().optional(),
        driverPhone: z.string().optional(),
        departureTime: z.string().optional(),
      });
      const body = schema.parse(request.body);

      const [assignment] = await db
        .insert(routeAssignments)
        .values(body)
        .returning();

      return reply.status(201).send({ assignment });
    }
  );
}
