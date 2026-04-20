import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pgClient } from "../lib/db.js";
import { adminAuth, requireRole } from "../middleware/admin-auth.js";
import { paginationSchema, paginationMeta, offsetFromPage } from "../lib/pagination.js";

export async function routeSheetRoutes(app: FastifyInstance) {
  // GET /api/v1/route-sheets — list with date/route/batch filters
  app.get(
    "/api/v1/route-sheets",
    { preHandler: [adminAuth, requireRole("route_sheets.view")] },
    async (request, reply) => {
      const querySchema = paginationSchema.extend({
        date: z.string().optional(),
        routeId: z.string().uuid().optional(),
        batchId: z.string().uuid().optional(),
        status: z.enum(["draft", "confirmed", "dispatched", "completed"]).optional(),
      });
      const query = querySchema.parse(request.query);
      const offset = offsetFromPage(query.page, query.limit);
      const filterDate = query.date ?? null;
      const routeId = query.routeId ?? null;
      const batchId = query.batchId ?? null;
      const status = query.status ?? null;

      const rows = await pgClient`
        SELECT rs.id, rs.date, rs.vehicle_number, rs.driver_name, rs.departure_time, rs.arrival_time,
               rs.total_crates, rs.total_amount, rs.dealer_count, rs.status, rs.notes, rs.created_at,
               r.code AS route_code, r.name AS route_name,
               b.name AS batch_name, b.batch_number,
               ct.name AS contractor_name,
               u.name AS generated_by_name
        FROM route_sheets rs
        JOIN routes r ON r.id = rs.route_id
        LEFT JOIN batches b ON b.id = rs.batch_id
        LEFT JOIN contractors ct ON ct.id = rs.contractor_id
        LEFT JOIN users u ON u.id = rs.generated_by
        WHERE (${filterDate}::date IS NULL OR rs.date = ${filterDate ?? '1970-01-01'}::date)
          AND (${routeId}::uuid IS NULL OR rs.route_id = ${routeId ?? '00000000-0000-0000-0000-000000000000'}::uuid)
          AND (${batchId}::uuid IS NULL OR rs.batch_id = ${batchId ?? '00000000-0000-0000-0000-000000000000'}::uuid)
          AND (${status}::text IS NULL OR rs.status = ${status ?? 'draft'}::route_sheet_status)
        ORDER BY rs.date DESC, r.code
        LIMIT ${query.limit} OFFSET ${offset}
      `;

      const [countRow] = await pgClient`
        SELECT count(*)::int AS count FROM route_sheets rs
        WHERE (${filterDate}::date IS NULL OR rs.date = ${filterDate ?? '1970-01-01'}::date)
          AND (${routeId}::uuid IS NULL OR rs.route_id = ${routeId ?? '00000000-0000-0000-0000-000000000000'}::uuid)
          AND (${batchId}::uuid IS NULL OR rs.batch_id = ${batchId ?? '00000000-0000-0000-0000-000000000000'}::uuid)
          AND (${status}::text IS NULL OR rs.status = ${status ?? 'draft'}::route_sheet_status)
      `;

      return reply.send({
        data: rows,
        ...paginationMeta(countRow?.count ?? 0, query.page, query.limit),
      });
    }
  );

  // GET /api/v1/route-sheets/:id — single route sheet with order details
  app.get(
    "/api/v1/route-sheets/:id",
    { preHandler: [adminAuth, requireRole("route_sheets.view")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const [sheet] = await pgClient`
        SELECT rs.*,
               r.code AS route_code, r.name AS route_name, r.zone_id,
               b.name AS batch_name, b.batch_number,
               ct.name AS contractor_name, ct.vehicle_number AS contractor_vehicle,
               u.name AS generated_by_name
        FROM route_sheets rs
        JOIN routes r ON r.id = rs.route_id
        LEFT JOIN batches b ON b.id = rs.batch_id
        LEFT JOIN contractors ct ON ct.id = rs.contractor_id
        LEFT JOIN users u ON u.id = rs.generated_by
        WHERE rs.id = ${id}
      `;
      if (!sheet) return reply.status(404).send({ error: "Route sheet not found" });

      // Get the orders for this route on this date
      const orders = await pgClient`
        SELECT o.id, o.dealer_id, o.status, o.grand_total, o.item_count, o.created_at,
               d.name AS dealer_name, d.phone AS dealer_phone
        FROM orders o
        JOIN dealers d ON d.id = o.dealer_id
        JOIN routes r ON r.zone_id = o.zone_id
        WHERE r.id = ${sheet.route_id}
          AND o.created_at::date = ${sheet.date}::date
          AND o.status IN ('confirmed', 'dispatched', 'delivered')
        ORDER BY d.name
      `;

      return reply.send({ sheet, orders });
    }
  );

  // POST /api/v1/route-sheets/generate — generate route sheet from posted indents
  // This is the "Post Indent" action: clubs pending orders for a route+batch+date into a sheet.
  app.post(
    "/api/v1/route-sheets/generate",
    { preHandler: [adminAuth, requireRole("route_sheets.manage")] },
    async (request, reply) => {
      const schema = z.object({
        routeId: z.string().uuid(),
        batchId: z.string().uuid().nullable().optional(),   // ← null or omitted means "all batches"
        date:    z.string(),
      });
      const body = schema.parse(request.body);

      // Check if route sheet already exists for this route+date+batch
      const existing = await pgClient`
        SELECT id FROM route_sheets
        WHERE route_id = ${body.routeId}
          AND date = ${body.date}::date
          AND (${body.batchId ?? null}::uuid IS NULL OR o.batch_id = ${body.batchId ?? '00000000-0000-0000-0000-000000000000'}::uuid)
        LIMIT 1
      `;
      if (existing.length > 0) {
        return reply.status(409).send({
          error: "Route sheet already exists for this route/date/batch",
          existingId: existing[0].id,
        });
      }

      // Get route + contractor info
      const [route] = await pgClient`
        SELECT r.id, r.code, r.name, r.zone_id, r.contractor_id,
               ct.name AS contractor_name, ct.vehicle_number
        FROM routes r
        LEFT JOIN contractors ct ON ct.id = r.contractor_id
        WHERE r.id = ${body.routeId}
      `;
      if (!route) return reply.status(404).send({ error: "Route not found" });

      // Count orders for this route's zone on this date
      const [orderStats] = await pgClient`
        SELECT count(*)::int AS dealer_count,
               COALESCE(sum(grand_total), 0)::numeric AS total_amount,
               COALESCE(sum(item_count), 0)::int AS total_items
        FROM orders
        WHERE zone_id = ${route.zone_id}
          AND created_at::date = ${body.date}::date
          AND status IN ('pending', 'confirmed')
      `;

      // Estimate crates: ~20 items per crate
      const totalCrates = Math.ceil((orderStats?.total_items ?? 0) / 20);

      const [sheet] = await pgClient`
        INSERT INTO route_sheets (route_id, batch_id, date, vehicle_number, driver_name,
                                   contractor_id, total_crates, total_amount, dealer_count, status, generated_by)
        VALUES (${body.routeId}, ${body.batchId ?? null}, ${body.date}::date,
                ${route.vehicle_number ?? null}, ${null},
                ${route.contractor_id ?? null},
                ${totalCrates}, ${orderStats?.total_amount ?? 0},
                ${orderStats?.dealer_count ?? 0}, 'draft', ${request.admin!.userId})
        RETURNING *
      `;

      // Update pending orders to confirmed for this zone+date
      await pgClient`
        UPDATE orders SET status = 'confirmed', confirmed_at = now(), updated_at = now()
        WHERE zone_id = ${route.zone_id}
          AND created_at::date = ${body.date}::date
          AND status = 'pending'
      `;

      return reply.status(201).send({ sheet, orderStats });
    }
  );

  // PATCH /api/v1/route-sheets/:id — update status, vehicle, driver, notes
  app.patch(
    "/api/v1/route-sheets/:id",
    { preHandler: [adminAuth, requireRole("route_sheets.manage")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const schema = z.object({
        vehicleNumber: z.string().optional(),
        driverName: z.string().optional(),
        departureTime: z.string().optional(),
        arrivalTime: z.string().optional(),
        totalCrates: z.number().int().optional(),
        status: z.enum(["draft", "confirmed", "dispatched", "completed"]).optional(),
        notes: z.string().nullable().optional(),
      });
      const body = schema.parse(request.body);

      const [updated] = await pgClient`
        UPDATE route_sheets SET
          vehicle_number = COALESCE(${body.vehicleNumber ?? null}, vehicle_number),
          driver_name = COALESCE(${body.driverName ?? null}, driver_name),
          departure_time = COALESCE(${body.departureTime ?? null}::time, departure_time),
          arrival_time = COALESCE(${body.arrivalTime ?? null}::time, arrival_time),
          total_crates = COALESCE(${body.totalCrates ?? null}::int, total_crates),
          status = COALESCE(${body.status ?? null}::route_sheet_status, status),
          notes = CASE WHEN ${body.notes !== undefined} THEN ${body.notes ?? null} ELSE notes END,
          updated_at = now()
        WHERE id = ${id}
        RETURNING *
      `;
      if (!updated) return reply.status(404).send({ error: "Route sheet not found" });
      return reply.send({ sheet: updated });
    }
  );
}
