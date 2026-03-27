import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, desc, sql, and, isNull } from "drizzle-orm";
import { db, pgClient } from "../lib/db.js";
import { users, approvalRequests, notificationConfig, dealers, dealerWallets } from "@hmu/db/schema";
import { adminAuth, requireRole } from "../middleware/admin-auth.js";
import { hashPassword } from "../lib/auth.js";
import { paginationSchema, paginationMeta, offsetFromPage } from "../lib/pagination.js";

export async function systemRoutes(app: FastifyInstance) {
  // ═══ ADMIN USERS ═══

  // GET /api/v1/users
  app.get(
    "/api/v1/users",
    { preHandler: [adminAuth, requireRole("system.users")] },
    async (request, reply) => {
      const query = paginationSchema.parse(request.query);
      const offset = offsetFromPage(query.page, query.limit);
      const [rows, [countRow]] = await Promise.all([
        db.select({ id: users.id, name: users.name, email: users.email, role: users.role, phone: users.phone, active: users.active, lastLoginAt: users.lastLoginAt, createdAt: users.createdAt })
          .from(users).where(isNull(users.deletedAt)).orderBy(desc(users.createdAt)).limit(query.limit).offset(offset),
        db.select({ count: sql<number>`count(*)::int` }).from(users).where(isNull(users.deletedAt)),
      ]);
      return reply.send({ data: rows, ...paginationMeta(countRow?.count ?? 0, query.page, query.limit) });
    }
  );

  // POST /api/v1/users
  app.post(
    "/api/v1/users",
    { preHandler: [adminAuth, requireRole("system.users")] },
    async (request, reply) => {
      const schema = z.object({
        name: z.string().min(1), email: z.string().email(), password: z.string().min(6),
        role: z.enum(["super_admin", "manager", "dispatch_officer", "accountant", "call_desk"]),
        phone: z.string().optional(), zoneId: z.string().uuid().optional(),
      });
      const body = schema.parse(request.body);
      const passwordHash = await hashPassword(body.password);
      const [user] = await db.insert(users).values({ ...body, password: undefined, passwordHash } as any).returning({ id: users.id, name: users.name, email: users.email, role: users.role });
      return reply.status(201).send({ user });
    }
  );

  // PATCH /api/v1/users/:id
  app.patch(
    "/api/v1/users/:id",
    { preHandler: [adminAuth, requireRole("system.users")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const schema = z.object({
        name: z.string().min(1).optional(), email: z.string().email().optional(),
        role: z.enum(["super_admin", "manager", "dispatch_officer", "accountant", "call_desk"]).optional(),
        phone: z.string().optional(), active: z.boolean().optional(),
      });
      const body = schema.parse(request.body);
      const [updated] = await db.update(users).set({ ...body, updatedAt: new Date() }).where(eq(users.id, id)).returning();
      if (!updated) return reply.status(404).send({ error: "User not found" });
      return reply.send({ user: updated });
    }
  );

  // PATCH /api/v1/users/:id/reset-password
  app.patch(
    "/api/v1/users/:id/reset-password",
    { preHandler: [adminAuth, requireRole("system.users")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const schema = z.object({ password: z.string().min(6) });
      const body = schema.parse(request.body);
      const passwordHash = await hashPassword(body.password);
      await db.update(users).set({ passwordHash, updatedAt: new Date() }).where(eq(users.id, id));
      return reply.send({ message: "Password reset" });
    }
  );

  // ═══ REGISTRATIONS ═══

  // GET /api/v1/registrations
  app.get(
    "/api/v1/registrations",
    { preHandler: [adminAuth, requireRole("dealers.manage")] },
    async (request, reply) => {
      const rows = await db.select().from(approvalRequests).orderBy(desc(approvalRequests.createdAt));
      return reply.send({ data: rows });
    }
  );

  // PATCH /api/v1/registrations/:id/approve
  app.patch(
    "/api/v1/registrations/:id/approve",
    { preHandler: [adminAuth, requireRole("dealers.manage")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const [req] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, id)).limit(1);
      if (!req) return reply.status(404).send({ error: "Not found" });
      if (req.status !== "pending") return reply.status(400).send({ error: "Already processed" });

      await db.update(approvalRequests).set({ status: "approved", reviewedBy: request.admin!.userId, reviewedAt: new Date() }).where(eq(approvalRequests.id, id));

      // If new registration, create the dealer
      if (req.type === "new_registration") {
        const data = JSON.parse(req.submittedData);
        const [dealer] = await pgClient`
          INSERT INTO dealers (name, phone, gst_number, zone_id, address, city, pin_code)
          VALUES (${data.name}, ${data.phone}, ${data.gstNumber ?? null}, ${data.zoneId}, ${data.address ?? null}, ${data.city ?? null}, ${data.pinCode ?? null})
          ON CONFLICT (phone) DO NOTHING RETURNING id
        `;
        if (dealer) {
          await pgClient`INSERT INTO dealer_wallets (dealer_id, balance) VALUES (${dealer.id}, 0)`;
        }
      }

      return reply.send({ message: "Registration approved" });
    }
  );

  // PATCH /api/v1/registrations/:id/reject
  app.patch(
    "/api/v1/registrations/:id/reject",
    { preHandler: [adminAuth, requireRole("dealers.manage")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const schema = z.object({ reviewNote: z.string().min(1) });
      const body = schema.parse(request.body);
      await db.update(approvalRequests).set({ status: "rejected", reviewedBy: request.admin!.userId, reviewNote: body.reviewNote, reviewedAt: new Date() }).where(eq(approvalRequests.id, id));
      return reply.send({ message: "Registration rejected" });
    }
  );

  // ═══ NOTIFICATION CONFIG ═══

  // GET /api/v1/notifications/config
  app.get(
    "/api/v1/notifications/config",
    { preHandler: [adminAuth] },
    async (request, reply) => {
      const configs = await db.select().from(notificationConfig);
      return reply.send({ data: configs });
    }
  );

  // PUT /api/v1/notifications/config
  app.put(
    "/api/v1/notifications/config",
    { preHandler: [adminAuth, requireRole("system.manage")] },
    async (request, reply) => {
      const schema = z.object({
        configs: z.array(z.object({
          eventName: z.string(),
          pushEnabled: z.string(),
        })),
      });
      const body = schema.parse(request.body);
      for (const cfg of body.configs) {
        await pgClient`
          UPDATE notification_config SET push_enabled = ${cfg.pushEnabled}, updated_at = now()
          WHERE event_name = ${cfg.eventName}
        `;
      }
      return reply.send({ message: "Notification config updated" });
    }
  );
}
