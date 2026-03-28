import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, isNull, desc } from "drizzle-orm";
import { db, pgClient } from "../lib/db.js";
import { dealers, dealerWallets, dealerLedger } from "@hmu/db/schema";
import { adminAuth, requireRole } from "../middleware/admin-auth.js";
import { dealerAuth } from "../middleware/dealer-auth.js";
import { paginationSchema, paginationMeta, offsetFromPage } from "../lib/pagination.js";

export async function dealerRoutes(app: FastifyInstance) {
  // GET /api/v1/dealers — paginated dealer list
  app.get(
    "/api/v1/dealers",
    { preHandler: [adminAuth, requireRole("dealers.view")] },
    async (request, reply) => {
      const querySchema = paginationSchema.extend({
        zoneId: z.string().uuid().optional(),
        search: z.string().optional(),
      });
      const query = querySchema.parse(request.query);
      const offset = offsetFromPage(query.page, query.limit);
      const searchTerm = query.search ? `%${query.search}%` : null;
      const zoneId = query.zoneId ?? null;

      const dataRows = await pgClient`
        SELECT d.id, d.name, d.phone, d.email, d.gst_number, d.city, d.active,
               d.address, d.pin_code, d.location_label, d.created_at,
               z.name AS zone_name, z.slug AS zone_slug,
               COALESCE(w.balance, 0) AS wallet_balance
        FROM dealers d
        JOIN zones z ON z.id = d.zone_id
        LEFT JOIN dealer_wallets w ON w.dealer_id = d.id
        WHERE d.deleted_at IS NULL
          AND (${searchTerm}::text IS NULL OR d.name ILIKE ${searchTerm ?? ''} OR d.phone ILIKE ${searchTerm ?? ''})
          AND (${zoneId}::uuid IS NULL OR d.zone_id = ${zoneId ?? '00000000-0000-0000-0000-000000000000'}::uuid)
        ORDER BY d.name ASC
        LIMIT ${query.limit} OFFSET ${offset}
      `;

      const [countRow] = await pgClient`
        SELECT count(*)::int AS count FROM dealers d
        WHERE d.deleted_at IS NULL
          AND (${searchTerm}::text IS NULL OR d.name ILIKE ${searchTerm ?? ''} OR d.phone ILIKE ${searchTerm ?? ''})
          AND (${zoneId}::uuid IS NULL OR d.zone_id = ${zoneId ?? '00000000-0000-0000-0000-000000000000'}::uuid)
      `;

      return reply.send({
        data: dataRows,
        ...paginationMeta(countRow?.count ?? 0, query.page, query.limit),
      });
    }
  );

  // GET /api/v1/dealers/:id
  app.get(
    "/api/v1/dealers/:id",
    { preHandler: [adminAuth, requireRole("dealers.view")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const [dealer] = await pgClient`
        SELECT d.*, z.name AS zone_name, COALESCE(w.balance, 0) AS wallet_balance
        FROM dealers d
        JOIN zones z ON z.id = d.zone_id
        LEFT JOIN dealer_wallets w ON w.dealer_id = d.id
        WHERE d.id = ${id} AND d.deleted_at IS NULL LIMIT 1
      `;
      if (!dealer) return reply.status(404).send({ error: "Dealer not found" });
      return reply.send({ dealer });
    }
  );

  // POST /api/v1/dealers — create dealer
  app.post(
    "/api/v1/dealers",
    { preHandler: [adminAuth, requireRole("dealers.manage")] },
    async (request, reply) => {
      const schema = z.object({
        name: z.string().min(1),
        phone: z.string().min(10),
        email: z.string().email().optional().or(z.literal("")),
        gstNumber: z.string().optional().or(z.literal("")),
        zoneId: z.string().uuid(),
        address: z.string().optional().or(z.literal("")),
        city: z.string().optional().or(z.literal("")),
        pinCode: z.string().optional().or(z.literal("")),
        locationLabel: z.string().optional().or(z.literal("")),
      });
      const body = schema.parse(request.body);

      const [existing] = await pgClient`SELECT id FROM dealers WHERE phone = ${body.phone} AND deleted_at IS NULL LIMIT 1`;
      if (existing) return reply.status(409).send({ error: "Dealer with this phone already exists" });

      const [dealer] = await pgClient`
        INSERT INTO dealers (name, phone, email, gst_number, zone_id, address, city, pin_code, location_label)
        VALUES (${body.name}, ${body.phone}, ${body.email || null}, ${body.gstNumber || null},
                ${body.zoneId}, ${body.address || null}, ${body.city || null}, ${body.pinCode || null}, ${body.locationLabel || null})
        RETURNING id, name, phone
      `;
      // Auto-create wallet
      await pgClient`INSERT INTO dealer_wallets (dealer_id, balance) VALUES (${dealer!.id}, 0)`;
      return reply.status(201).send({ dealer });
    }
  );

  // PATCH /api/v1/dealers/:id
  app.patch(
    "/api/v1/dealers/:id",
    { preHandler: [adminAuth, requireRole("dealers.manage")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const schema = z.object({
        name: z.string().min(1).optional(), phone: z.string().optional(),
        email: z.string().email().optional(), gstNumber: z.string().optional(),
        active: z.boolean().optional(), address: z.string().optional(),
        city: z.string().optional(), pinCode: z.string().optional(),
      });
      const body = schema.parse(request.body);
      const [updated] = await db.update(dealers)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(dealers.id, id))
        .returning();
      if (!updated) return reply.status(404).send({ error: "Not found" });
      return reply.send({ dealer: updated });
    }
  );

  // POST /api/v1/wallet/topup
  app.post(
    "/api/v1/wallet/topup",
    { preHandler: [adminAuth, requireRole("dealers.manage")] },
    async (request, reply) => {
      const schema = z.object({
        dealerId: z.string().uuid(),
        amount: z.number().positive(),
        description: z.string().optional(),
      });
      const body = schema.parse(request.body);

      const [wallet] = await pgClient`
        UPDATE dealer_wallets SET balance = balance + ${body.amount}::numeric, updated_at = now()
        WHERE dealer_id = ${body.dealerId} RETURNING balance
      `;
      if (!wallet) return reply.status(404).send({ error: "Wallet not found" });

      await pgClient`
        INSERT INTO dealer_ledger (dealer_id, type, amount, reference_type, description, balance_after, performed_by)
        VALUES (${body.dealerId}, 'credit', ${body.amount}::numeric, 'wallet_topup',
                ${body.description || 'Admin wallet top-up'}, ${wallet.balance}::numeric, ${request.admin!.userId})
      `;
      return reply.send({ message: "Top-up successful", balance: wallet.balance });
    }
  );

  // GET /api/v1/dealers/:id/ledger
  app.get(
    "/api/v1/dealers/:id/ledger",
    { preHandler: [adminAuth, requireRole("dealers.view")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const query = paginationSchema.parse(request.query);
      const offset = offsetFromPage(query.page, query.limit);

      const rows = await pgClient`
        SELECT id, type, amount, reference_id, reference_type, description, balance_after,
               created_at AS "createdAt"
        FROM dealer_ledger WHERE dealer_id = ${id}
        ORDER BY created_at DESC
        LIMIT ${query.limit} OFFSET ${offset}
      `;

      const [countRow] = await pgClient`
        SELECT count(*)::int AS count FROM dealer_ledger WHERE dealer_id = ${id}
      `;

      return reply.send({ data: rows, ...paginationMeta(countRow?.count ?? 0, query.page, query.limit) });
    }
  );

  // GET /api/v1/dealer/profile — dealer's own profile
  app.get(
    "/api/v1/dealer/profile",
    { preHandler: [dealerAuth] },
    async (request, reply) => {
      const dealerId = request.dealer!.dealerId;
      const [dealer] = await pgClient`
        SELECT d.*, z.name AS zone_name, COALESCE(w.balance, 0) AS wallet_balance
        FROM dealers d JOIN zones z ON z.id = d.zone_id
        LEFT JOIN dealer_wallets w ON w.dealer_id = d.id
        WHERE d.id = ${dealerId} LIMIT 1
      `;
      if (!dealer) return reply.status(404).send({ error: "Not found" });
      return reply.send({ dealer });
    }
  );
}
