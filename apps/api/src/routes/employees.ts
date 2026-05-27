import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pgClient } from "../lib/db.js";
import { adminAuth, requireRole } from "../middleware/admin-auth.js";

export async function employeesRoutes(app: FastifyInstance) {
  // GET /api/v1/employees — list employees, now with route info
  app.get(
    "/api/v1/employees",
    { preHandler: [adminAuth, requireRole("employees.view")] },
    async (request, reply) => {
      const q = z.object({
        search:     z.string().optional(),
        activeOnly: z.coerce.boolean().optional().default(true),
      }).parse(request.query);
      const s = q.search ? `%${q.search}%` : null;
 
      const rows = await pgClient`
        SELECT e.id, e.employee_code, e.name, e.phone,
               e.department, e.designation, e.active, e.created_at,
               e.route_id, e.route_position,
               r.code AS route_code, r.name AS route_name
          FROM employees e
          LEFT JOIN routes r
            ON r.id = e.route_id AND r.deleted_at IS NULL
         WHERE e.deleted_at IS NULL
           AND (${q.activeOnly}::boolean = false OR e.active = true)
           AND (${s}::text IS NULL
                OR e.name ILIKE ${s ?? ''}
                OR e.employee_code ILIKE ${s ?? ''}
                OR e.phone ILIKE ${s ?? ''})
         ORDER BY e.name
         LIMIT 500
      `;
      return reply.send({ data: rows });
    }
  );
 
 
  // ── NEW ───────────────────────────────────────────────────────────
  // POST /api/v1/employees/:id/route — assign employee to a route
  // Body: { routeId }
  // Sets route_id and parks the employee at the end of that route
  // (route_position = max real position + 10, same gap rule as dealers).
  app.post(
    "/api/v1/employees/:id/route",
    { preHandler: [adminAuth, requireRole("employees.manage")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = z.object({ routeId: z.string().uuid() }).parse(request.body);
 
      const [emp] = await pgClient`
        SELECT id FROM employees WHERE id = ${id} AND deleted_at IS NULL
      `;
      if (!emp) return reply.status(404).send({ error: "Employee not found" });
 
      const [rt] = await pgClient`
        SELECT id FROM routes WHERE id = ${body.routeId} AND deleted_at IS NULL
      `;
      if (!rt) return reply.status(404).send({ error: "Route not found" });
 
      // Next position = max real (non-default) position on the route + 10.
      const [maxRow] = await pgClient`
        SELECT COALESCE(MAX(route_position), 0) + 10 AS next_pos
          FROM employees
         WHERE route_id = ${body.routeId}::uuid
           AND deleted_at IS NULL
           AND route_position < 9999
      `;
      const nextPos = Number(maxRow?.next_pos) || 10;
 
      const [updated] = await pgClient`
        UPDATE employees
           SET route_id = ${body.routeId}::uuid,
               route_position = ${nextPos},
               updated_at = now()
         WHERE id = ${id}
        RETURNING id, route_id, route_position
      `;
      return reply.status(200).send({ employee: updated });
    }
  );
 
 
  // ── NEW ───────────────────────────────────────────────────────────
  // DELETE /api/v1/employees/:id/route — unassign employee from route
  app.delete(
    "/api/v1/employees/:id/route",
    { preHandler: [adminAuth, requireRole("employees.manage")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const [updated] = await pgClient`
        UPDATE employees
           SET route_id = NULL,
               route_position = 9999,
               updated_at = now()
         WHERE id = ${id} AND deleted_at IS NULL
        RETURNING id
      `;
      if (!updated) return reply.status(404).send({ error: "Employee not found" });
      return reply.send({ message: "Employee removed from route" });
    }
  );
 
 
  // ── NEW ───────────────────────────────────────────────────────────
  // PATCH /api/v1/routes/:routeId/employee-positions
  // Body: { positions: [{ employeeId, position }, ...] }
  // Bulk-rewrites route_position for employees on this route — the
  // employee mirror of PATCH /routes/:routeId/dealer-positions.
  app.patch(
    "/api/v1/routes/:routeId/employee-positions",
    { preHandler: [adminAuth, requireRole("employees.manage")] },
    async (request, reply) => {
      const { routeId } = request.params as { routeId: string };
      const body = z.object({
        positions: z.array(z.object({
          employeeId: z.string().uuid(),
          position:   z.number().int().min(1),
        })).min(1).max(2000),
      }).parse(request.body);
 
      await pgClient.begin(async (_tx) => {
        const tx = _tx as unknown as typeof pgClient;
        const employeeIds = body.positions.map(p => p.employeeId);
        const positions   = body.positions.map(p => p.position);
        await tx`
          UPDATE employees e
             SET route_position = v.position,
                 updated_at = now()
            FROM (
              SELECT UNNEST(${employeeIds}::uuid[]) AS employee_id,
                     UNNEST(${positions}::int[])    AS position
            ) v
           WHERE e.id = v.employee_id
             AND e.route_id = ${routeId}::uuid
        `;
      });
 
      const rows = await pgClient`
        SELECT id, employee_code, name, route_position
          FROM employees
         WHERE route_id = ${routeId}::uuid AND deleted_at IS NULL
         ORDER BY route_position NULLS LAST, employee_code, name
      `;
      return reply.send({ routeId, employees: rows });
    }
  );

  // GET /api/v1/employee-subsidy-rules — products + their active subsidy %
  app.get(
    "/api/v1/employee-subsidy-rules",
    { preHandler: [adminAuth, requireRole("employees.view")] },
    async (_request, reply) => {
      const rows = await pgClient`
        SELECT r.id, r.product_id, r.subsidy_percent, r.active,
               p.name AS product_name, p.code AS product_code,
               p.base_price, p.gst_percent, p.unit
        FROM employee_subsidy_rules r
        JOIN products p ON p.id = r.product_id
        WHERE r.active = true AND p.deleted_at IS NULL
        ORDER BY p.name
      `;
      return reply.send({ data: rows });
    }
  );

  // POST /api/v1/employees
  app.post(
    "/api/v1/employees",
    { preHandler: [adminAuth, requireRole("employees.manage")] },
    async (request, reply) => {
      const body = z.object({
        employeeCode: z.string().optional(),
        name:         z.string().min(1),
        phone:        z.string().optional(),
        department:   z.string().optional(),
        designation:  z.string().optional(),
        active:       z.boolean().optional().default(true),
      }).parse(request.body);

      const [row] = await pgClient`
        INSERT INTO employees (employee_code, name, phone, department, designation, active)
        VALUES (${body.employeeCode ?? null}, ${body.name},
                ${body.phone ?? null}, ${body.department ?? null},
                ${body.designation ?? null}, ${body.active})
        RETURNING id, employee_code, name, phone, department, designation, active
      `;
      return reply.status(201).send({ employee: row });
    }
  );

  // PATCH /api/v1/employees/:id
  app.patch(
    "/api/v1/employees/:id",
    { preHandler: [adminAuth, requireRole("employees.manage")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = z.object({
        employeeCode: z.string().nullable().optional(),
        name:         z.string().min(1).optional(),
        phone:        z.string().nullable().optional(),
        department:   z.string().nullable().optional(),
        designation:  z.string().nullable().optional(),
        active:       z.boolean().optional(),
      }).parse(request.body);

      const [row] = await pgClient`
        UPDATE employees SET
          employee_code = ${body.employeeCode === undefined ? pgClient`employee_code` : body.employeeCode},
          name          = COALESCE(${body.name ?? null}, name),
          phone         = ${body.phone       === undefined ? pgClient`phone`         : body.phone},
          department    = ${body.department  === undefined ? pgClient`department`    : body.department},
          designation   = ${body.designation === undefined ? pgClient`designation`   : body.designation},
          active        = COALESCE(${body.active ?? null}, active),
          updated_at    = now()
        WHERE id = ${id} AND deleted_at IS NULL
        RETURNING id, employee_code, name, phone, department, designation, active
      `;
      if (!row) return reply.status(404).send({ error: "Employee not found" });
      return reply.send({ employee: row });
    }
  );

  // DELETE /api/v1/employees/:id — soft delete
  app.delete(
    "/api/v1/employees/:id",
    { preHandler: [adminAuth, requireRole("employees.manage")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await pgClient`UPDATE employees SET deleted_at = now() WHERE id = ${id} AND deleted_at IS NULL`;
      return reply.send({ ok: true });
    }
  );
}