import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, isNull, sql, desc, and } from "drizzle-orm";
import { db, pgClient } from "../lib/db.js";
import {
  dealers,
  dealerWallets,
  dealerLedger,
  zones,
} from "@hmu/db/schema";
import { adminAuth, requireRole } from "../middleware/admin-auth.js";
import { dealerAuth } from "../middleware/dealer-auth.js";
import { paginationSchema, paginationMeta, offsetFromPage } from "../lib/pagination.js";

export async function dealerRoutes(app: FastifyInstance) {
  // GET /api/v1/dealers — paginated dealer list (admin)
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

      const conditions: any[] = [sql`d.deleted_at IS NULL`];
      if (query.zoneId) conditions.push(sql`d.zone_id = ${query.zoneId}::uuid`);
      if (query.search) conditions.push(sql`(d.name ILIKE ${"%" + query.search + "%"} OR d.phone ILIKE ${"%" + query.search + "%"})`);
      const whereClause = sql`WHERE ${sql.join(conditions, sql` AND `)}`;

      const [dataRows, [countRow]] = await Promise.all([
        pgClient`
          SELECT d.id, d.name, d.phone, d.gst_number, d.city, d.active,
                 d.location_label, d.created_at,
                 z.name AS zone_name, z.slug AS zone_slug,
                 COALESCE(w.balance, 0) AS wallet_balance
          FROM dealers d
          JOIN zones z ON z.id = d.zone_id
          LEFT JOIN dealer_wallets w ON w.dealer_id = d.id
          ${whereClause}
          ORDER BY d.name ASC
          LIMIT ${query.limit} OFFSET ${offset}
        `,
        pgClient`SELECT count(*)::int AS count FROM dealers d ${whereClause}`,
      ]);

      return reply.status(200).send({
        data: dataRows,
        ...paginationMeta(countRow?.count ?? 0, query.page, query.limit),
      });
    }
  );

  // GET /api/v1/dealers/:id — dealer detail
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
        WHERE d.id = ${id} AND d.deleted_at IS NULL
        LIMIT 1
      `;

      if (!dealer) {
        return reply.status(404).send({ error: "Dealer not found" });
      }

      return reply.status(200).send({ dealer });
    }
  );

  // POST /api/v1/dealers — create dealer (admin)
  app.post(
    "/api/v1/dealers",
    { preHandler: [adminAuth, requireRole("dealers.manage")] },
    async (request, reply) => {
      const schema = z.object({
        name: z.string().min(1),
        phone: z.string().min(10).max(15),
        email: z.string().email().optional(),
        gstNumber: z.string().optional(),
        zoneId: z.string().uuid(),
        address: z.string().optional(),
        city: z.string().optional(),
        pinCode: z.string().optional(),
        locationLabel: z.string().optional(),
        contactPerson: z.string().optional(),
      });
      const body = schema.parse(request.body);

      // Create dealer + wallet in transaction
      const result = await pgClient.begin(async (tx) => {
        const [dealer] = await tx`
          INSERT INTO dealers (name, phone, email, gst_number, zone_id, address, city, pin_code, location_label, contact_person)
          VALUES (${body.name}, ${body.phone}, ${body.email ?? null}, ${body.gstNumber ?? null},
                  ${body.zoneId}, ${body.address ?? null}, ${body.city ?? null},
                  ${body.pinCode ?? null}, ${body.locationLabel ?? null}, ${body.contactPerson ?? null})
          RETURNING *
        `;

        await tx`
          INSERT INTO dealer_wallets (dealer_id, balance)
          VALUES (${dealer!.id}, 0)
        `;

        return dealer;
      });

      return reply.status(201).send({ dealer: result });
    }
  );

  // PATCH /api/v1/dealers/:id — update dealer (admin)
  app.patch(
    "/api/v1/dealers/:id",
    { preHandler: [adminAuth, requireRole("dealers.manage")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const schema = z.object({
        name: z.string().min(1).optional(),
        email: z.string().email().optional(),
        gstNumber: z.string().optional(),
        zoneId: z.string().uuid().optional(),
        address: z.string().optional(),
        city: z.string().optional(),
        pinCode: z.string().optional(),
        locationLabel: z.string().optional(),
        contactPerson: z.string().optional(),
        active: z.boolean().optional(),
      });
      const body = schema.parse(request.body);

      const [updated] = await db
        .update(dealers)
        .set({ ...body, updatedAt: new Date() })
        .where(and(eq(dealers.id, id), isNull(dealers.deletedAt)))
        .returning();

      if (!updated) {
        return reply.status(404).send({ error: "Dealer not found" });
      }

      return reply.status(200).send({ dealer: updated });
    }
  );

  // POST /api/v1/wallet/topup — top up dealer wallet (admin)
  app.post(
    "/api/v1/wallet/topup",
    { preHandler: [adminAuth, requireRole("dealers.wallet")] },
    async (request, reply) => {
      const schema = z.object({
        dealerId: z.string().uuid(),
        amount: z.number().positive(),
        description: z.string().optional(),
      });
      const body = schema.parse(request.body);

      const result = await pgClient.begin(async (tx) => {
        // Atomic balance update
        const [wallet] = await tx`
          UPDATE dealer_wallets
          SET balance = balance + ${body.amount.toFixed(2)}::numeric,
              last_topup_at = now(),
              last_topup_amount = ${body.amount.toFixed(2)}::numeric,
              updated_at = now()
          WHERE dealer_id = ${body.dealerId}
          RETURNING balance
        `;

        if (!wallet) {
          throw new Error("Dealer wallet not found");
        }

        // Ledger entry (append-only)
        await tx`
          INSERT INTO dealer_ledger (dealer_id, type, amount, reference_type, description, balance_after, performed_by)
          VALUES (${body.dealerId}, 'credit', ${body.amount.toFixed(2)}::numeric,
                  'wallet_topup', ${body.description ?? "Wallet top-up"},
                  ${wallet.balance}::numeric, ${request.admin!.userId})
        `;

        return wallet;
      });

      return reply.status(200).send({
        message: "Wallet topped up successfully",
        newBalance: result!.balance,
      });
    }
  );

  // GET /api/v1/dealers/:id/ledger — dealer ledger (paginated, append-only)
  app.get(
    "/api/v1/dealers/:id/ledger",
    { preHandler: [adminAuth, requireRole("finance.view")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const query = paginationSchema.parse(request.query);
      const offset = offsetFromPage(query.page, query.limit);

      const [dataRows, [countRow]] = await Promise.all([
        db
          .select()
          .from(dealerLedger)
          .where(eq(dealerLedger.dealerId, id))
          .orderBy(desc(dealerLedger.createdAt))
          .limit(query.limit)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(dealerLedger)
          .where(eq(dealerLedger.dealerId, id)),
      ]);

      return reply.status(200).send({
        data: dataRows,
        ...paginationMeta(countRow?.count ?? 0, query.page, query.limit),
      });
    }
  );

  // GET /api/v1/dealer/profile — dealer's own profile (from app)
  app.get(
    "/api/v1/dealer/profile",
    { preHandler: [dealerAuth] },
    async (request, reply) => {
      const [dealer] = await pgClient`
        SELECT d.id, d.name, d.phone, d.email, d.gst_number, d.zone_id,
               d.address, d.city, d.pin_code, d.location_label,
               d.language_preference, d.biometric_enabled, d.notifications_enabled,
               z.name AS zone_name,
               COALESCE(w.balance, 0) AS wallet_balance
        FROM dealers d
        JOIN zones z ON z.id = d.zone_id
        LEFT JOIN dealer_wallets w ON w.dealer_id = d.id
        WHERE d.id = ${request.dealer!.dealerId}
        LIMIT 1
      `;

      return reply.status(200).send({ dealer });
    }
  );
}
