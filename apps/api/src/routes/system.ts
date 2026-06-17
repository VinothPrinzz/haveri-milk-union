import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, desc, sql, and, isNull } from "drizzle-orm";
import { db, pgClient } from "../lib/db.js";
import { users, approvalRequests, notificationConfig, dealers, dealerWallets } from "@hmu/db/schema";
import { adminAuth, requireRole } from "../middleware/admin-auth.js";
import { hashPassword } from "../lib/auth.js";
import { paginationSchema, paginationMeta, offsetFromPage } from "../lib/pagination.js";
import { enqueuePushNotification } from "../lib/queue.js";

export async function systemRoutes(app: FastifyInstance) {
  // ═══ ADMIN USERS ═══
  // GET /api/v1/users
  app.get(
    "/api/v1/users",
    { preHandler: [adminAuth, requireRole("system.users")] },
    async (request, reply) => {
      const query  = paginationSchema.parse(request.query);
      const offset = offsetFromPage(query.page, query.limit);
   
      const [rows, [countRow]] = await Promise.all([
        db
          .select({
            id:          users.id,
            name:        users.name,
            username:    users.username,   // ← added
            email:       users.email,
            role:        users.role,
            phone:       users.phone,
            active:      users.active,
            lastLoginAt: users.lastLoginAt,
            createdAt:   users.createdAt,
          })
          .from(users)
          .where(isNull(users.deletedAt))
          .orderBy(desc(users.createdAt))
          .limit(query.limit)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(users)
          .where(isNull(users.deletedAt)),
      ]);
   
      return reply.send({
        data: rows,
        ...paginationMeta(countRow?.count ?? 0, query.page, query.limit),
      });
    },
  );

  // POST /api/v1/users
  app.post(
    "/api/v1/users",
    { preHandler: [adminAuth, requireRole("system.users")] },
    async (request, reply) => {
      const schema = z.object({
        name:     z.string().min(1),
        username: z.string().min(3).max(32).regex(/^[a-z0-9_]+$/i, "Username may only contain letters, numbers and underscores"),
        email:    z.string().email(),
        password: z.string().min(6),
        role:     z.enum(["super_admin", "manager", "dispatch_officer", "accountant", "call_desk", "officer", "viewer"]),
        phone:    z.string().optional(),
        zoneId:   z.string().uuid().optional(),
      });
   
      const body         = schema.parse(request.body);
      const passwordHash = await hashPassword(body.password);
   
      // Check username uniqueness (gives a cleaner error than a DB constraint violation)
      const [existing] = await db
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            eq(sql`LOWER(${users.username})`, body.username.toLowerCase()),
            isNull(users.deletedAt),
          ),
        )
        .limit(1);
   
      if (existing) {
        return reply.status(409).send({ error: "Conflict", message: "Username already taken" });
      }
   
      const [user] = await db
        .insert(users)
        .values({ ...body, password: undefined, passwordHash } as any)
        .returning({ id: users.id, name: users.name, username: users.username, email: users.email, role: users.role });
   
      return reply.status(201).send({ user });
    },
  );

  // PATCH /api/v1/users/:id
  app.patch(
    "/api/v1/users/:id",
    { preHandler: [adminAuth, requireRole("system.users")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
   
      const schema = z.object({
        name:     z.string().min(1).optional(),
        username: z.string().min(3).max(32).regex(/^[a-z0-9_]+$/i).optional(),
        email:    z.string().email().optional(),
        role:     z.enum(["super_admin", "manager", "dispatch_officer", "accountant", "call_desk", "officer", "viewer"]).optional(),
        phone:    z.string().optional(),
        active:   z.boolean().optional(),
      });
   
      const body = schema.parse(request.body);
   
      // If changing username, check uniqueness first
      if (body.username) {
        const [conflict] = await db
          .select({ id: users.id })
          .from(users)
          .where(
            and(
              eq(sql`LOWER(${users.username})`, body.username.toLowerCase()),
              isNull(users.deletedAt),
            ),
          )
          .limit(1);
   
        if (conflict && conflict.id !== id) {
          return reply.status(409).send({ error: "Conflict", message: "Username already taken" });
        }
      }
   
      const [updated] = await db
        .update(users)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(users.id, id))
        .returning();
   
      if (!updated) return reply.status(404).send({ error: "User not found" });
      return reply.send({ user: updated });
    },
  );

  // PATCH /api/v1/users/:id/reset-password
  app.patch(
    "/api/v1/users/:id/reset-password",
    { preHandler: [adminAuth, requireRole("system.users")] },
    async (request, reply) => {
      const { id }       = request.params as { id: string };
      const { password } = z.object({ password: z.string().min(6) }).parse(request.body);
      const passwordHash = await hashPassword(password);
      await db.update(users).set({ passwordHash, updatedAt: new Date() }).where(eq(users.id, id));
      return reply.send({ message: "Password reset" });
    },
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

  // ═══ NOTIFICATIONS LOG (admin views) ═══
  // GET /api/v1/notifications — list broadcast history.
  // Aggregates per-broadcast send/delivered/failed counts from notifications_log.
  // A "broadcast" row is one notifications_log row when target_type='all' or 'zone';
  // for per-dealer sends the same logical broadcast may have one row per dealer
  // (we do not yet group them), so the counts reflect that single row.
  app.get(
    "/api/v1/notifications",
    { preHandler: [adminAuth, requireRole("system.view")] },
    async (request, reply) => {
      const q = z.object({
        limit: z.coerce.number().int().min(1).max(500).default(100),
      }).parse(request.query);
      const data = await pgClient`
        SELECT id,
               title,
               message,
               target_type,
               target_id,
               channel,
               status,
               created_at,
               sent_at,
               delivered_at,
               CASE WHEN sent_at      IS NOT NULL THEN 1 ELSE 0 END AS sent,
               CASE WHEN delivered_at IS NOT NULL THEN 1 ELSE 0 END AS delivered,
               CASE WHEN status = 'failed'        THEN 1 ELSE 0 END AS failed
        FROM notifications_log
        ORDER BY created_at DESC
        LIMIT ${q.limit}
      `;
      return reply.send({ data });
    }
  );

  // GET /api/v1/notifications/dealer-log — per-dealer notification history.
  // Resolves target_id → dealer name for target_type='dealer'; for 'all' / 'zone'
  // rows the dealer_name is blank (frontend already tolerates the empty string).
  app.get(
    "/api/v1/notifications/dealer-log",
    { preHandler: [adminAuth, requireRole("system.view")] },
    async (request, reply) => {
      const q = z.object({
        limit: z.coerce.number().int().min(1).max(500).default(100),
      }).parse(request.query);
      const data = await pgClient`
        SELECT n.id,
               n.title,
               n.message,
               n.channel,
               n.status,
               n.sent_at,
               n.delivered_at,
               n.created_at,
               n.target_type,
               n.target_id,
               d.name AS dealer_name
        FROM notifications_log n
        LEFT JOIN dealers d
          ON n.target_type = 'dealer'
         AND d.id = n.target_id
        ORDER BY n.created_at DESC
        LIMIT ${q.limit}
      `;
      return reply.send({ data });
    }
  );

  // ═══ NOTIFICATIONS SEND ═══
  // POST /api/v1/notifications/send — send notification to dealers
  app.post(
    "/api/v1/notifications/send",
    { preHandler: [adminAuth, requireRole("system.manage")] },
    async (request, reply) => {
      const schema = z.object({
        title: z.string().min(1),
        message: z.string().min(1),
        target: z.object({
          type: z.enum(["all", "dealer", "zone"]).default("all"),
          id: z.string().uuid().optional(),
        }).optional(),
        channel: z.enum(["push", "sms", "email"]).default("push"),
      });
      const body = schema.parse(request.body);
      const targetType = body.target?.type ?? "all";
      const targetId = body.target?.id ?? null;
      const [logged] = await pgClient`
        INSERT INTO notifications_log (target_type, target_id, channel, title, message, status, sent_at)
        VALUES (${targetType}, ${targetId}::uuid, ${body.channel}::notif_channel,
                ${body.title}, ${body.message}, 'queued', now())
        RETURNING id, created_at
      `;
      if (!logged) return reply.status(500).send({ error: "Failed to queue notification" });
      return reply.status(200).send({
        message: "Notification queued for sending",
        id: logged.id,
        targetType,
        targetId,
      });
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

  // ═══ TIME WINDOWS — route-driven ═══
  //
  // One row per active route. time_windows is LEFT JOINed so routes
  // without a configured window still appear with sensible defaults;
  // the upsert endpoint below creates the row on first save.
  app.get(
    "/api/v1/time-windows",
    { preHandler: [adminAuth, requireRole("system.view")] },
    async (_request, reply) => {
      const windows = await pgClient`
        SELECT r.id                       AS route_id,
              r.name                     AS route_name,
              r.code                     AS route_code,
              tw.id                      AS id,
              COALESCE(tw.open_time,       '06:00'::time) AS open_time,
              COALESCE(tw.warning_minutes, 20)             AS warning_minutes,
              COALESCE(tw.close_time,      '08:00'::time) AS close_time,
              COALESCE(tw.active,          true)           AS active,
              (tw.id IS NOT NULL)        AS configured
        FROM routes r
        LEFT JOIN time_windows tw ON tw.route_id = r.id
        WHERE r.deleted_at IS NULL
          AND r.active = true
        ORDER BY r.code
      `;
      return reply.send({ windows });
    }
  );

  // PATCH /api/v1/time-windows/route/:routeId — upsert by route_id.
  // (Old PATCH /:id can stay or be removed; this one is what the UI uses.)
  app.patch(
    "/api/v1/time-windows/route/:routeId",
    { preHandler: [adminAuth, requireRole("system.manage")] },
    async (request, reply) => {
      const { routeId } = request.params as { routeId: string };
      const schema = z.object({
        openTime:       z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
        warningMinutes: z.number().int().min(0).max(240),
        closeTime:      z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
        active:         z.boolean().optional(),
      });
      const body = schema.parse(request.body);

      const [row] = await pgClient`
        INSERT INTO time_windows (route_id, open_time, warning_minutes, close_time, active)
        VALUES (
          ${routeId}::uuid,
          ${body.openTime}::time,
          ${body.warningMinutes},
          ${body.closeTime}::time,
          ${body.active ?? true}
        )
        ON CONFLICT (route_id) DO UPDATE SET
          open_time       = EXCLUDED.open_time,
          warning_minutes = EXCLUDED.warning_minutes,
          close_time      = EXCLUDED.close_time,
          active          = EXCLUDED.active
        RETURNING *
      `;
      return reply.send({ window: row });
    }
  );

  // PATCH /api/v1/time-windows/:id — update time window
  app.patch(
    "/api/v1/time-windows/:id",
    { preHandler: [adminAuth, requireRole("system.manage")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const schema = z.object({
        openTime: z.string().optional(),
        warningMinutes: z.number().int().optional(),
        closeTime: z.string().optional(),
        active: z.boolean().optional(),
      });
      const body = schema.parse(request.body);
      const [updated] = await pgClient`
        UPDATE time_windows SET
          open_time = COALESCE(${body.openTime ?? null}::time, open_time),
          warning_minutes = COALESCE(${body.warningMinutes ?? null}::int, warning_minutes),
          close_time = COALESCE(${body.closeTime ?? null}::time, close_time),
          active = COALESCE(${body.active ?? null}::boolean, active),
          updated_at = now()
        WHERE id = ${id}
        RETURNING *
      `;
      if (!updated) return reply.status(404).send({ error: "Time window not found" });
      return reply.send({ window: updated });
    }
  );

  // ═══ NOTIFICATION CONFIG (FIX #25) ═══
  // GET /api/v1/notification-config — list notification settings
  app.get(
    "/api/v1/notification-config",
    { preHandler: [adminAuth, requireRole("system.view")] },
    async (request, reply) => {
      const config = await pgClient`
        SELECT id,
              event_name AS event,
              description,
              target_channel,
              push_enabled, sms_enabled, email_enabled,
              (push_enabled = 'true') AS enabled
        FROM notification_config
        ORDER BY event_name
      `;
      return reply.send({ config });
    }
  );

  // ═══ SYSTEM SETTINGS HELPER — NEW ENDPOINT ═══
  // GET /api/v1/system-settings/marketing
  app.get(
    "/api/v1/system-settings/marketing",
    { preHandler: [adminAuth] },
    async (_request, reply) => {
      const rows = await pgClient`
        SELECT key, value FROM system_settings WHERE category = 'marketing'
      `;
      const out: Record<string, any> = {};
      for (const r of rows as any[]) {
        try {
          out[r.key] = typeof r.value === "string" ? JSON.parse(r.value) : r.value;
        } catch {
          out[r.key] = r.value;
        }
      }
      return reply.send(out);
      // Expected shape:
      // {
      //   states: [...],
      //   address_types: [...],
      //   talukas: [...],
      //   cities: [...]
      // }
    }
  );
}