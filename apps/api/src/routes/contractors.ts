import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pgClient } from "../lib/db.js";
import { adminAuth, requireRole } from "../middleware/admin-auth.js";
import { paginationSchema, paginationMeta, offsetFromPage } from "../lib/pagination.js";

export async function contractorRoutes(app: FastifyInstance) {
  // GET /api/v1/contractors — paginated list with search & zone filter
  app.get(
    "/api/v1/contractors",
    { preHandler: [adminAuth, requireRole("contractors.view")] },
    async (request, reply) => {
      const querySchema = paginationSchema.extend({
        zoneId: z.string().uuid().optional(),
        search: z.string().optional(),
        active: z.enum(["true", "false"]).optional(),
        name: z.string().optional(),
        assignedRouteId: z.string().uuid().optional(),
        status: z.enum(["active", "inactive"]).optional(),
      });

      const query = querySchema.parse(request.query);
      const offset = offsetFromPage(query.page, query.limit);

      // === Normalized filters (never undefined) ===
      const searchTerm = query.search ? `%${query.search}%` : null;
      const zoneId = query.zoneId ?? null;
      const nameTerm = query.name ? `%${query.name}%` : null;
      const assignedRouteId = query.assignedRouteId ?? null;

      // Boolean filters (null | boolean)
      const activeFilter = query.active !== undefined ? query.active === "true" : null;
      const statusFilter = query.status === "active" ? true
                        : query.status === "inactive" ? false
                        : null;

      const rows = await pgClient`
        SELECT
          c.*,
          z.name AS zone_name, z.slug AS zone_slug,
          COALESCE(
            (SELECT json_agg(json_build_object('id', r.id, 'code', r.code, 'name', r.name))
            FROM routes r
            WHERE r.contractor_id = c.id AND r.deleted_at IS NULL),
            '[]'::json
          ) AS assigned_routes,
          COALESCE(
            ARRAY(SELECT r.id FROM routes r WHERE r.contractor_id = c.id AND r.deleted_at IS NULL),
            ARRAY[]::uuid[]
          ) AS route_ids
        FROM contractors c
        LEFT JOIN zones z ON z.id = c.zone_id
        WHERE c.deleted_at IS NULL
          AND (${searchTerm}::text IS NULL 
              OR c.name ILIKE ${searchTerm}::text 
              OR c.phone ILIKE ${searchTerm}::text 
              OR c.code ILIKE ${searchTerm}::text)
          AND (${zoneId}::uuid IS NULL OR c.zone_id = ${zoneId}::uuid)
          AND (${activeFilter}::boolean IS NULL OR c.active = ${activeFilter}::boolean)
          AND (${nameTerm}::text IS NULL OR c.name ILIKE ${nameTerm}::text)
          AND (${statusFilter}::boolean IS NULL OR c.active = ${statusFilter}::boolean)
          AND (${assignedRouteId}::uuid IS NULL OR EXISTS (
                SELECT 1 FROM routes r
                WHERE r.contractor_id = c.id AND r.id = ${assignedRouteId}::uuid
              ))
        ORDER BY c.code NULLS LAST, c.name ASC
        LIMIT ${query.limit} OFFSET ${offset}
      `;

      // === Count query - EXACT same conditions ===
      const [countRow] = await pgClient`
        SELECT count(*)::int AS count 
        FROM contractors c
        WHERE c.deleted_at IS NULL
          AND (${searchTerm}::text IS NULL 
              OR c.name ILIKE ${searchTerm}::text 
              OR c.phone ILIKE ${searchTerm}::text 
              OR c.code ILIKE ${searchTerm}::text)
          AND (${zoneId}::uuid IS NULL OR c.zone_id = ${zoneId}::uuid)
          AND (${activeFilter}::boolean IS NULL OR c.active = ${activeFilter}::boolean)
          AND (${nameTerm}::text IS NULL OR c.name ILIKE ${nameTerm}::text)
          AND (${statusFilter}::boolean IS NULL OR c.active = ${statusFilter}::boolean)
          AND (${assignedRouteId}::uuid IS NULL OR EXISTS (
                SELECT 1 FROM routes r
                WHERE r.contractor_id = c.id AND r.id = ${assignedRouteId}::uuid
              ))
      `;

      return reply.send({
        data: rows,
        ...paginationMeta(countRow?.count ?? 0, query.page, query.limit),
      });
    }
  );

  // GET /api/v1/contractors/:id  (unchanged - was already safe)
  app.get(
    "/api/v1/contractors/:id",
    { preHandler: [adminAuth, requireRole("contractors.view")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const [contractor] = await pgClient`
        SELECT c.*, z.name AS zone_name
        FROM contractors c
        LEFT JOIN zones z ON z.id = c.zone_id
        WHERE c.id = ${id} AND c.deleted_at IS NULL
      `;

      if (!contractor) return reply.status(404).send({ error: "Contractor not found" });

      const assignedRoutes = await pgClient`
        SELECT r.id, r.code, r.name, r.active
        FROM routes r 
        WHERE r.contractor_id = ${id} AND r.deleted_at IS NULL
        ORDER BY r.code
      `;

      return reply.send({ contractor, assignedRoutes });
    }
  );

  // POST /api/v1/contractors — create + assign routes atomically
  app.post(
    "/api/v1/contractors",
    { preHandler: [adminAuth, requireRole("contractors.manage")] },
    async (request, reply) => {
      const schema = z.object({
        name: z.string().min(1),
        phone: z.string().min(10),
        email: z.string().email().or(z.literal("")).optional().nullable(),
        licenseNumber: z.string().optional().nullable(),
        bankName: z.string().optional().nullable(),
        accountNo: z.string().optional().nullable(),
        ratePerKm: z.union([z.string(), z.number()]).optional().nullable(),
        vehicleNumber: z.string().optional().nullable(),
        periodFrom: z.string().optional().nullable(),
        periodTo: z.string().optional().nullable(),
        addressType: z.enum(["Office", "Residence"]).or(z.literal("")).optional().nullable(),
        state: z.string().optional().nullable(),
        city: z.string().optional().nullable(),
        area: z.string().optional().nullable(),
        houseNo: z.string().optional().nullable(),
        street: z.string().optional().nullable(),
        address: z.string().optional().nullable(),
        zoneId: z.string().uuid().optional(), // kept for backward compat
        code: z.string().optional(),
        routeIds: z.array(z.string().uuid()).optional(),
        active: z.boolean().optional(),
      });
      const body = schema.parse(request.body);

      const result = await pgClient.begin(async (tx) => {
        let code = body.code;
        if (!code) {
          const [last] = await tx`
            SELECT code FROM contractors
            WHERE code ~ '^CTR-[0-9]+$' AND deleted_at IS NULL
            ORDER BY CAST(SUBSTRING(code FROM 5) AS integer) DESC
            LIMIT 1
          `;
          const lastNum = last ? parseInt(last.code.slice(4)) : 0;
          code = `CTR-${String(lastNum + 1).padStart(4, "0")}`;
        }

        const [contractor] = await tx`
          INSERT INTO contractors (
            code, name, phone, email, license_number, zone_id, address,
            vehicle_number, bank_name, account_no, rate_per_km,
            address_type, state, city, area, house_no, street,
            period_from, period_to, active
          ) VALUES (
            ${code}, ${body.name}, ${body.phone}, ${body.email ?? null},
            ${body.licenseNumber ?? null}, ${body.zoneId ?? null}, ${body.address ?? null},
            ${body.vehicleNumber ?? null}, ${body.bankName ?? null}, ${body.accountNo ?? null},
            ${body.ratePerKm != null ? String(body.ratePerKm) : null}::numeric,
            ${body.addressType ?? null}, ${body.state ?? null}, ${body.city ?? null},
            ${body.area ?? null}, ${body.houseNo ?? null}, ${body.street ?? null},
            ${body.periodFrom ?? null}::date, ${body.periodTo ?? null}::date,
            ${body.active !== false}
          )
          RETURNING *
        `;

        if (!contractor) throw new Error("Failed to create contractor");

        if (body.routeIds && body.routeIds.length > 0) {
          await tx`
            UPDATE routes
            SET contractor_id = ${contractor.id}, updated_at = now()
            WHERE id = ANY(${body.routeIds}::uuid[]) AND deleted_at IS NULL
          `;
        }
        return contractor;
      });

      return reply.status(201).send({ contractor: result });
    }
  );

  // PATCH /api/v1/contractors/:id — update + optionally re-assign routes
  app.patch(
    "/api/v1/contractors/:id",
    { preHandler: [adminAuth, requireRole("contractors.manage")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const schema = z.object({
        name: z.string().min(1).optional(),
        phone: z.string().min(10).optional(),
        email: z.string().email().or(z.literal("")).optional().nullable(),
        licenseNumber: z.string().optional().nullable(),
        bankName: z.string().optional().nullable(),
        accountNo: z.string().optional().nullable(),
        ratePerKm: z.union([z.string(), z.number()]).optional().nullable(),
        vehicleNumber: z.string().optional().nullable(),
        periodFrom: z.string().optional().nullable(),
        periodTo: z.string().optional().nullable(),
        addressType: z.enum(["Office", "Residence"]).or(z.literal("")).optional().nullable(),
        state: z.string().optional().nullable(),
        city: z.string().optional().nullable(),
        area: z.string().optional().nullable(),
        houseNo: z.string().optional().nullable(),
        street: z.string().optional().nullable(),
        address: z.string().optional().nullable(),
        zoneId: z.string().uuid().nullable().optional(),
        code: z.string().optional(),
        active: z.boolean().optional(),
        routeIds: z.array(z.string().uuid()).optional(),
      });
      const body = schema.parse(request.body);

      const result = await pgClient.begin(async (tx) => {
        const [updated] = await tx`
          UPDATE contractors SET
            name = COALESCE(${body.name ?? null}, name),
            phone = COALESCE(${body.phone ?? null}, phone),
            email = COALESCE(${body.email ?? null}, email),
            license_number = COALESCE(${body.licenseNumber ?? null}, license_number),
            bank_name = COALESCE(${body.bankName ?? null}, bank_name),
            account_no = COALESCE(${body.accountNo ?? null}, account_no),
            rate_per_km = COALESCE(${body.ratePerKm != null ? String(body.ratePerKm) : null}::numeric, rate_per_km),
            vehicle_number = COALESCE(${body.vehicleNumber ?? null}, vehicle_number),
            period_from = COALESCE(${body.periodFrom ?? null}::date, period_from),
            period_to = COALESCE(${body.periodTo ?? null}::date, period_to),
            address_type = COALESCE(${body.addressType ?? null}, address_type),
            state = COALESCE(${body.state ?? null}, state),
            city = COALESCE(${body.city ?? null}, city),
            area = COALESCE(${body.area ?? null}, area),
            house_no = COALESCE(${body.houseNo ?? null}, house_no),
            street = COALESCE(${body.street ?? null}, street),
            address = COALESCE(${body.address ?? null}, address),
            zone_id = CASE WHEN ${body.zoneId !== undefined} THEN ${body.zoneId ?? null}::uuid ELSE zone_id END,
            active = COALESCE(${body.active ?? null}::boolean, active),
            updated_at = now()
          WHERE id = ${id} AND deleted_at IS NULL
          RETURNING *
        `;

        if (!updated) return null;

        if (body.routeIds !== undefined) {
          await tx`UPDATE routes SET contractor_id = NULL, updated_at = now() WHERE contractor_id = ${id}`;
          if (body.routeIds.length > 0) {
            await tx`
              UPDATE routes SET contractor_id = ${id}, updated_at = now()
              WHERE id = ANY(${body.routeIds}::uuid[]) AND deleted_at IS NULL
            `;
          }
        }
        return updated;
      });

      if (!result) return reply.status(404).send({ error: "Contractor not found" });
      return reply.send({ contractor: result });
    }
  );

  // DELETE /api/v1/contractors/:id
  app.delete(
    "/api/v1/contractors/:id",
    { preHandler: [adminAuth, requireRole("contractors.manage")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await pgClient`UPDATE routes SET contractor_id = NULL WHERE contractor_id = ${id}`;
      await pgClient`UPDATE contractors SET deleted_at = now() WHERE id = ${id} AND deleted_at IS NULL`;
      return reply.send({ message: "Contractor deleted" });
    }
  );
}