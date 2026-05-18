import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pgClient } from "../lib/db.js";
import { adminAuth, requireRole } from "../middleware/admin-auth.js";

export async function employeesRoutes(app: FastifyInstance) {
  // GET /api/v1/employees
  app.get(
    "/api/v1/employees",
    { preHandler: [adminAuth, requireRole("employees.view")] },
    async (request, reply) => {
      const q = z.object({
        search:        z.string().optional(),
        activeOnly:    z.coerce.boolean().optional().default(true),
      }).parse(request.query);
      const s = q.search ? `%${q.search}%` : null;

      const rows = await pgClient`
        SELECT id, employee_code, name, phone, department, designation, active, created_at
        FROM employees
        WHERE deleted_at IS NULL
          AND (${q.activeOnly}::boolean = false OR active = true)
          AND (${s}::text IS NULL
               OR name ILIKE ${s ?? ''}
               OR employee_code ILIKE ${s ?? ''}
               OR phone ILIKE ${s ?? ''})
        ORDER BY name
        LIMIT 500
      `;
      return reply.send({ data: rows });
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