// ══════════════════════════════════════════════════════════════════
// Dealers routes — Phase 5 update
// Added: code, customer_type, rate_category, pay_mode, route_id,
// bank, officer_name fields throughout all endpoints.
// ══════════════════════════════════════════════════════════════════
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pgClient } from "../lib/db.js";
import { adminAuth, requireRole } from "../middleware/admin-auth.js";
import { dealerAuth } from "../middleware/dealer-auth.js";
import {
  paginationSchema,
  paginationMeta,
  offsetFromPage,
} from "../lib/pagination.js";

export async function dealerRoutes(app: FastifyInstance) {
  // ═══════════════════════════════════════════════════════════════
  // GET /api/v1/dealers — paginated dealer list with marketing fields
  // ═══════════════════════════════════════════════════════════════
  async function getDefaultZoneId(): Promise<string> {
    const [zone] = await pgClient`
      SELECT id FROM zones WHERE active = true ORDER BY name LIMIT 1
    `;
    if (!zone) throw new Error("No active zones found");
    return zone.id;
  }

  app.get(
    "/api/v1/dealers",
    { preHandler: [adminAuth, requireRole("dealers.view")] },
    async (request, reply) => {
      const querySchema = paginationSchema.extend({
        zoneId: z.string().uuid().optional(),
        search: z.string().optional(),
        customerType: z.string().optional(),
        payMode: z.string().optional(),
        routeId: z.string().uuid().optional(),
        name: z.string().optional(),
        typeFilter: z.string().optional(),
        batchId: z.string().uuid().optional(),
      });

      const query = querySchema.parse(request.query);
      const offset = offsetFromPage(query.page, query.limit);
      const searchTerm = query.search ? `%${query.search}%` : null;
      const zoneId = query.zoneId ?? null;
      const customerType = query.customerType ?? null;
      const payMode = query.payMode ?? null;
      const routeId = query.routeId ?? null;

      const dataRows = await pgClient`
        SELECT
          d.id, d.name, d.phone, d.email, d.gst_number,
          d.city, d.active, d.address, d.pin_code, d.location_label,
          d.created_at,
          d.code, d.customer_type, d.rate_category, d.pay_mode,
          d.route_id,
          d.bank, d.officer_name,
          d.account_no, d.address_type, d.state, d.area, d.house_no, d.street,
          d.last_indent_at,
          z.name AS zone_name, z.slug AS zone_slug,
          r.name AS route_name,
          r.code AS route_code,
          COALESCE(w.balance, 0) AS wallet_balance,
          COALESCE(w.balance, 0) AS credit_balance,
          COALESCE(
            (SELECT json_agg(json_build_object(
                'routeId', r2.id,
                'routeCode', r2.code,
                'routeName', r2.name,
                'isPrimary', dr.is_primary
              ) ORDER BY dr.is_primary DESC, r2.code)
            FROM dealer_routes dr
            JOIN routes r2 ON r2.id = dr.route_id AND r2.deleted_at IS NULL
            WHERE dr.dealer_id = d.id),
            '[]'::json
          ) AS routes
        FROM dealers d
        JOIN zones z ON z.id = d.zone_id
        LEFT JOIN routes r ON r.id = d.route_id AND r.deleted_at IS NULL
        LEFT JOIN dealer_wallets w ON w.dealer_id = d.id
        WHERE d.deleted_at IS NULL
          AND (${searchTerm}::text IS NULL OR d.name ILIKE ${searchTerm ?? ""} OR d.phone ILIKE ${searchTerm ?? ""} OR d.code ILIKE ${searchTerm ?? ""})
          AND (${zoneId}::uuid IS NULL OR d.zone_id = ${zoneId ?? "00000000-0000-0000-0000-000000000000"}::uuid)
          AND (${customerType}::text IS NULL OR d.customer_type::text = ${customerType ?? ""})
          AND (${payMode}::text IS NULL OR d.pay_mode::text = ${payMode ?? ""})
          AND (${routeId}::uuid IS NULL OR EXISTS (SELECT 1 FROM dealer_routes dr WHERE dr.dealer_id = d.id AND dr.route_id = ${routeId ?? "00000000-0000-0000-0000-000000000000"}::uuid))
          AND (${query.name ?? null}::text IS NULL OR d.name ILIKE ${`%${query.name ?? ''}%`})
          AND (${query.typeFilter ?? null}::text IS NULL OR d.customer_type::text = ${query.typeFilter ?? ''})
          AND (${query.routeId ?? null}::uuid IS NULL OR d.route_id = ${query.routeId ?? '00000000-0000-0000-0000-000000000000'}::uuid)
          AND (${query.batchId ?? null}::uuid IS NULL OR EXISTS (
                SELECT 1 FROM routes r 
                WHERE r.id = d.route_id 
                  AND r.primary_batch_id = ${query.batchId ?? '00000000-0000-0000-0000-000000000000'}::uuid
              ))
        ORDER BY d.name ASC
        LIMIT ${query.limit} OFFSET ${offset}
      `;

      const [countRow] = await pgClient`
        SELECT count(*)::int AS count FROM dealers d
        WHERE d.deleted_at IS NULL
          AND (${searchTerm}::text IS NULL OR d.name ILIKE ${searchTerm ?? ""} OR d.phone ILIKE ${searchTerm ?? ""})
          AND (${zoneId}::uuid IS NULL OR d.zone_id = ${zoneId ?? "00000000-0000-0000-0000-000000000000"}::uuid)
      `;

      return reply.send({
        data: dataRows,
        ...paginationMeta(countRow?.count ?? 0, query.page, query.limit),
      });
    },
  );

  // GET /api/v1/dealers/:id
  app.get(
    "/api/v1/dealers/:id",
    { preHandler: [adminAuth, requireRole("dealers.view")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const [dealer] = await pgClient`
        SELECT
          d.*,
          d.account_no, d.address_type, d.state, d.area, d.house_no, d.street, d.last_indent_at,
          z.name AS zone_name,
          r.name AS route_name,
          r.code AS route_code,
          COALESCE(w.balance, 0) AS wallet_balance,
          COALESCE(
            (SELECT json_agg(json_build_object(
                'routeId', r2.id,
                'routeCode', r2.code,
                'routeName', r2.name,
                'isPrimary', dr.is_primary
              ) ORDER BY dr.is_primary DESC, r2.code)
            FROM dealer_routes dr
            JOIN routes r2 ON r2.id = dr.route_id AND r2.deleted_at IS NULL
            WHERE dr.dealer_id = d.id),
            '[]'::json
          ) AS routes
        FROM dealers d
        JOIN zones z ON z.id = d.zone_id
        LEFT JOIN routes r ON r.id = d.route_id AND r.deleted_at IS NULL
        LEFT JOIN dealer_wallets w ON w.dealer_id = d.id
        WHERE d.id = ${id} AND d.deleted_at IS NULL
        LIMIT 1
      `;
      if (!dealer) return reply.status(404).send({ error: "Dealer not found" });
      return reply.send({ dealer });
    },
  );

  // POST /api/v1/dealers
  app.post(
    "/api/v1/dealers",
    { preHandler: [adminAuth, requireRole("dealers.manage")] },
    async (request, reply) => {
      const schema = z.object({
        name: z.string().min(1),
        phone: z.string().min(10),
        email: z.string().email().optional().or(z.literal("")),
        gstNumber: z.string().optional().or(z.literal("")),
        zoneId: z.string().uuid().optional(),
        address: z.string().optional().or(z.literal("")),
        city: z.string().optional().or(z.literal("")),
        pinCode: z.string().optional().or(z.literal("")),
        locationLabel: z.string().optional().or(z.literal("")),
        code: z.string().optional(),
        customerType: z.enum(["Retail-Dealer","Credit Inst-MRP","Credit Inst-Dealer","Parlour-Dealer"]).optional(),
        rateCategory: z.string().optional(),
        payMode: z.enum(["Cash", "Credit"]).optional(),
        routeId: z.string().uuid().optional(),
        bank: z.string().optional(),
        officerName: z.string().optional(),
        active: z.boolean().optional(),
        accountNo: z.string().optional().nullable(),
        addressType: z.enum(["Office", "Residence"]).optional().nullable(),
        state: z.string().optional().nullable(),
        area: z.string().optional().nullable(),
        houseNo: z.string().optional().nullable(),
        street: z.string().optional().nullable(),
      });

      const body = schema.parse(request.body);

      const [existing] = await pgClient`
        SELECT id FROM dealers WHERE phone = ${body.phone} AND deleted_at IS NULL LIMIT 1
      `;
      if (existing) return reply.status(409).send({ error: "Dealer with this phone already exists" });

      if (body.code) {
        const [codeExists] = await pgClient`
          SELECT id FROM dealers WHERE code = ${body.code} AND deleted_at IS NULL LIMIT 1
        `;
        if (codeExists) return reply.status(409).send({ error: `Code ${body.code} is already taken` });
      }

      const [dealer] = await pgClient`
        INSERT INTO dealers (
          name, phone, email, gst_number, zone_id, address, city, pin_code, location_label,
          code, customer_type, rate_category, pay_mode, route_id, bank, officer_name, active,
          account_no, address_type, state, area, house_no, street
        )
        VALUES (
          ${body.name}, ${body.phone}, ${body.email || null}, ${body.gstNumber || null},
          ${body.zoneId || (await getDefaultZoneId())}, ${body.address || null}, ${body.city || null},
          ${body.pinCode || null}, ${body.locationLabel || null},
          ${body.code || null}, ${body.customerType || "Retail-Dealer"},
          ${body.rateCategory || body.customerType || "Retail-Dealer"}, ${body.payMode || "Cash"},
          ${body.routeId || null}, ${body.bank || null}, ${body.officerName || null},
          ${body.active !== false},
          ${body.accountNo || null}, ${body.addressType || null}, ${body.state || null},
          ${body.area || null}, ${body.houseNo || null}, ${body.street || null}
        )
        RETURNING *
      `;

      await pgClient`
        INSERT INTO dealer_wallets (dealer_id, balance)
        VALUES (${dealer!.id}, 0)
        ON CONFLICT (dealer_id) DO NOTHING
      `;

      return reply.status(201).send({ dealer });
    },
  );

  // PATCH /api/v1/dealers/:id — Only ONE handler (the latest version)
  app.patch(
    "/api/v1/dealers/:id",
    { preHandler: [adminAuth, requireRole("dealers.manage")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const schema = z.object({
        name: z.string().min(1).optional(),
        phone: z.string().optional(),
        email: z.string().email().optional(),
        gstNumber: z.string().optional(),
        active: z.boolean().optional(),
        address: z.string().optional(),
        city: z.string().optional(),
        pinCode: z.string().optional(),
        code: z.string().optional().nullable(),
        customerType: z.enum(["Retail-Dealer","Credit Inst-MRP","Credit Inst-Dealer","Parlour-Dealer"]).optional(),
        rateCategory: z.string().optional(),
        payMode: z.enum(["Cash", "Credit"]).optional(),
        routeId: z.string().uuid().optional().nullable(),
        bank: z.string().optional().nullable(),
        officerName: z.string().optional().nullable(),
        accountNo: z.string().optional().nullable(),
        addressType: z.enum(["Office", "Residence"]).optional().nullable(),
        state: z.string().optional().nullable(),
        area: z.string().optional().nullable(),
        houseNo: z.string().optional().nullable(),
        street: z.string().optional().nullable(),
      });

      const body = schema.parse(request.body);

      const result = await pgClient.begin(async (tx) => {
        const [updated] = await tx`
          UPDATE dealers SET
            name = COALESCE(${body.name ?? null}, name),
            phone = COALESCE(${body.phone ?? null}, phone),
            email = CASE WHEN ${body.email !== undefined} THEN ${body.email ?? null} ELSE email END,
            gst_number = CASE WHEN ${body.gstNumber !== undefined} THEN ${body.gstNumber ?? null} ELSE gst_number END,
            active = COALESCE(${body.active ?? null}::boolean, active),
            address = CASE WHEN ${body.address !== undefined} THEN ${body.address ?? null} ELSE address END,
            city = CASE WHEN ${body.city !== undefined} THEN ${body.city ?? null} ELSE city END,
            pin_code = CASE WHEN ${body.pinCode !== undefined} THEN ${body.pinCode ?? null} ELSE pin_code END,
            code = CASE WHEN ${body.code !== undefined} THEN ${body.code ?? null} ELSE code END,
            customer_type = COALESCE(${body.customerType ?? null}::customer_type, customer_type),
            rate_category = COALESCE(${body.rateCategory ?? null}, rate_category),
            pay_mode = COALESCE(${body.payMode ?? null}::pay_mode, pay_mode),
            route_id = CASE WHEN ${body.routeId !== undefined} THEN ${body.routeId ?? null}::uuid ELSE route_id END,
            bank = CASE WHEN ${body.bank !== undefined} THEN ${body.bank ?? null} ELSE bank END,
            officer_name = CASE WHEN ${body.officerName !== undefined} THEN ${body.officerName ?? null} ELSE officer_name END,
            account_no = CASE WHEN ${body.accountNo !== undefined} THEN ${body.accountNo ?? null} ELSE account_no END,
            address_type = CASE WHEN ${body.addressType !== undefined} THEN ${body.addressType ?? null} ELSE address_type END,
            state = CASE WHEN ${body.state !== undefined} THEN ${body.state ?? null} ELSE state END,
            area = CASE WHEN ${body.area !== undefined} THEN ${body.area ?? null} ELSE area END,
            house_no = CASE WHEN ${body.houseNo !== undefined} THEN ${body.houseNo ?? null} ELSE house_no END,
            street = CASE WHEN ${body.street !== undefined} THEN ${body.street ?? null} ELSE street END,
            updated_at = now()
          WHERE id = ${id} AND deleted_at IS NULL
          RETURNING *
        `;

        if (!updated) return null;

        if (body.routeId !== undefined) {
          await tx`UPDATE dealer_routes SET is_primary = false WHERE dealer_id = ${id}`;
          if (body.routeId) {
            await tx`
              INSERT INTO dealer_routes (dealer_id, route_id, is_primary)
              VALUES (${id}, ${body.routeId}::uuid, true)
              ON CONFLICT (dealer_id, route_id) DO UPDATE SET is_primary = true
            `;
          }
        }
        return updated;
      });

      if (!result) return reply.status(404).send({ error: "Dealer not found" });
      return reply.send({ dealer: result });
    },
  );

  // ═══════════════════════════════════════════════════════════════
  // POST /api/v1/dealers/:id/routes — add a route (does NOT replace)
  // Issue #2
  // ═══════════════════════════════════════════════════════════════
  app.post(
    "/api/v1/dealers/:id/routes",
    { preHandler: [adminAuth, requireRole("dealers.manage")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const schema = z.object({
        routeId: z.string().uuid(),
        isPrimary: z.boolean().optional().default(false),
      });
      const body = schema.parse(request.body);

      // Confirm dealer + route exist
      const [d] =
        await pgClient`SELECT id FROM dealers WHERE id = ${id} AND deleted_at IS NULL`;
      if (!d) return reply.status(404).send({ error: "Dealer not found" });
      const [r] =
        await pgClient`SELECT id FROM routes WHERE id = ${body.routeId} AND deleted_at IS NULL`;
      if (!r) return reply.status(404).send({ error: "Route not found" });

      await pgClient.begin(async (tx) => {
        if (body.isPrimary) {
          // Demote any existing primary first
          await tx`UPDATE dealer_routes SET is_primary = false WHERE dealer_id = ${id}`;
          await tx`UPDATE dealers SET route_id = ${body.routeId}::uuid, updated_at = now() WHERE id = ${id}`;
        } else {
          // If the dealer has no primary route yet, make this one primary.
          const [any] =
            await tx`SELECT 1 FROM dealer_routes WHERE dealer_id = ${id} AND is_primary = true LIMIT 1`;
          if (!any) {
            await tx`UPDATE dealers SET route_id = ${body.routeId}::uuid, updated_at = now() WHERE id = ${id}`;
          }
        }

        await tx`
          INSERT INTO dealer_routes (dealer_id, route_id, is_primary)
          VALUES (${id}, ${body.routeId}::uuid, ${body.isPrimary || false})
          ON CONFLICT (dealer_id, route_id) DO UPDATE
            SET is_primary = EXCLUDED.is_primary OR dealer_routes.is_primary
        `;
      });

      // Return the updated set of routes for this dealer
      const routes = await pgClient`
        SELECT r.id AS "routeId", r.code AS "routeCode", r.name AS "routeName",
               dr.is_primary AS "isPrimary"
        FROM dealer_routes dr JOIN routes r ON r.id = dr.route_id
        WHERE dr.dealer_id = ${id}
        ORDER BY dr.is_primary DESC, r.code
      `;
      return reply.status(201).send({ dealerId: id, routes });
    },
  );

  // ═══════════════════════════════════════════════════════════════
  // DELETE /api/v1/dealers/:id/routes/:routeId — remove one route
  // ═══════════════════════════════════════════════════════════════
  app.delete(
    "/api/v1/dealers/:id/routes/:routeId",
    { preHandler: [adminAuth, requireRole("dealers.manage")] },
    async (request, reply) => {
      const { id, routeId } = request.params as { id: string; routeId: string };

      await pgClient.begin(async (tx) => {
        const [removed] = await tx`
          DELETE FROM dealer_routes
          WHERE dealer_id = ${id} AND route_id = ${routeId}
          RETURNING is_primary
        `;
        if (!removed) return;
        // If the removed row was primary, promote another one (or null out dealers.route_id).
        if (removed.is_primary) {
          const [next] = await tx`
            SELECT route_id FROM dealer_routes
            WHERE dealer_id = ${id} ORDER BY created_at LIMIT 1
          `;
          if (next) {
            await tx`UPDATE dealer_routes SET is_primary = true WHERE dealer_id = ${id} AND route_id = ${next.route_id}`;
            await tx`UPDATE dealers SET route_id = ${next.route_id}, updated_at = now() WHERE id = ${id}`;
          } else {
            await tx`UPDATE dealers SET route_id = NULL, updated_at = now() WHERE id = ${id}`;
          }
        }
      });

      const routes = await pgClient`
        SELECT r.id AS "routeId", r.code AS "routeCode", r.name AS "routeName",
               dr.is_primary AS "isPrimary"
        FROM dealer_routes dr JOIN routes r ON r.id = dr.route_id
        WHERE dr.dealer_id = ${id}
        ORDER BY dr.is_primary DESC, r.code
      `;
      return reply.send({ dealerId: id, routes });
    },
  );

  // ═══════════════════════════════════════════════════════════════
  // POST /api/v1/wallet/topup
  // ═══════════════════════════════════════════════════════════════
  app.post(
    "/api/v1/wallet/topup",
    { preHandler: [adminAuth, requireRole("dealers.wallet")] },
    async (request, reply) => {
      const schema = z.object({
        dealerId: z.string().uuid(),
        amount: z.number().positive(),
        reference: z.string().optional(),
        notes: z.string().optional(),
      });
      const body = schema.parse(request.body);

      // Atomic balance update
      const [wallet] = await pgClient`
        UPDATE dealer_wallets
        SET balance = balance + ${body.amount},
            last_topup_at = now(),
            last_topup_amount = ${body.amount},
            updated_at = now()
        WHERE dealer_id = ${body.dealerId}
        RETURNING balance
      `;
      if (!wallet)
        return reply.status(404).send({ error: "Dealer wallet not found" });

      // Append-only ledger entry
      await pgClient`
        INSERT INTO dealer_ledger (dealer_id, type, amount, reference_type, balance_after, notes)
        VALUES (${body.dealerId}, 'credit', ${body.amount}, 'wallet_topup', ${wallet.balance}, ${body.notes ?? null})
      `;

      return reply.send({
        balance: parseFloat(wallet.balance),
        message: "Wallet topped up",
      });
    },
  );

  // ═══════════════════════════════════════════════════════════════
  // GET /api/v1/dealers/:id/ledger — append-only transaction history
  // ═══════════════════════════════════════════════════════════════
  app.get(
    "/api/v1/dealers/:id/ledger",
    { preHandler: [adminAuth, requireRole("dealers.view")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const querySchema = paginationSchema.extend({
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      });
      const q = querySchema.parse(request.query);
      const offset = offsetFromPage(q.page, q.limit);
   
      const from = q.from ?? null;
      const to   = q.to   ?? null;
   
      // Running balance computed via window function over the full
      // filtered set, ordered ASC (chronological). The list is then
      // reversed to DESC for display. This keeps the running balance
      // correct for the filtered date range (it starts from the
      // opening balance of that range).
      //
      // For the page-level opening balance we use the /summary
      // endpoint — this one just returns the rows.
      const rows = await pgClient`
        WITH filtered AS (
          SELECT
            dl.id,
            dl.type,
            dl.amount,
            dl.reference_id      AS "referenceId",
            dl.reference_type    AS "referenceType",
            dl.description,
            dl.voucher_no        AS "voucherNo",
            dl.voucher_type      AS "voucherType",
            dl.particulars,
            COALESCE(dl.voucher_date, dl.created_at::date) AS "voucherDate",
            dl.created_at        AS "createdAt",
            dl.balance_after     AS "storedBalance",
            -- Running balance: cumulative credit - debit within the
            -- filtered set. Uses numeric to avoid float drift.
            SUM(CASE WHEN dl.type = 'credit' THEN dl.amount ELSE -dl.amount END)
              OVER (ORDER BY dl.created_at, dl.id
                    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
              AS running_delta
          FROM dealer_ledger dl
          WHERE dl.dealer_id = ${id}
            AND (${from}::date IS NULL OR COALESCE(dl.voucher_date, dl.created_at::date) >= ${from ?? '1970-01-01'}::date)
            AND (${to}::date   IS NULL OR COALESCE(dl.voucher_date, dl.created_at::date) <= ${to   ?? '9999-12-31'}::date)
        )
        SELECT * FROM filtered
        ORDER BY "createdAt" DESC, id DESC
        LIMIT ${q.limit} OFFSET ${offset}
      `;
   
      const [countRow] = await pgClient`
        SELECT count(*)::int AS count
        FROM dealer_ledger dl
        WHERE dl.dealer_id = ${id}
          AND (${from}::date IS NULL OR COALESCE(dl.voucher_date, dl.created_at::date) >= ${from ?? '1970-01-01'}::date)
          AND (${to}::date   IS NULL OR COALESCE(dl.voucher_date, dl.created_at::date) <= ${to   ?? '9999-12-31'}::date)
      `;
   
      return reply.send({
        data: rows,
        ...paginationMeta(countRow?.count ?? 0, q.page, q.limit),
      });
    }
  );
   
   
  // ════════════════════════════════════════════════════════════════════
  // PART 4 — Add to apps/api/src/routes/dealers.ts (NEW)
  // ════════════════════════════════════════════════════════════════════
   
  // ┌─────────────────────────────────────────────────┐
  // │   GET /api/v1/dealers/:id/ledger/summary          │
  // │   6 summary tiles                                 │
  // └─────────────────────────────────────────────────┘
  app.get(
    "/api/v1/dealers/:id/ledger/summary",
    { preHandler: [adminAuth, requireRole("dealers.view")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const querySchema = z.object({
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      });
      const q = querySchema.parse(request.query);
      const from = q.from ?? null;
      const to   = q.to   ?? null;
   
      // Dealer's credit limit + opening_balance setup.
      const [dealer] = await pgClient`
        SELECT
          d.id, d.name, d.code,
          COALESCE(d.credit_limit, 0)::numeric    AS credit_limit,
          COALESCE(d.opening_balance, 0)::numeric AS static_opening_balance,
          d.opening_balance_date                  AS opening_balance_date
        FROM dealers d
        WHERE d.id = ${id} AND d.deleted_at IS NULL
        LIMIT 1
      `;
      if (!dealer) return reply.status(404).send({ error: "Dealer not found" });
   
      // Single query with 3 aggregations:
      //   • opening_before: net ledger delta for rows BEFORE `from` (or
      //     everything if no `from`) — this is the carried-forward
      //     balance as of the start of the filtered period
      //   • debits/credits in the filtered range
      //   • closing computed as opening + credits - debits (in Node)
      //
      // The "opening_balance" tile = dealer.opening_balance + opening_before
      // (if `from` is set) OR just dealer.opening_balance (if not).
      const [agg] = await pgClient`
        SELECT
          -- Before-range net (credit - debit) for rows strictly before "from"
          COALESCE(SUM(
            CASE
              WHEN ${from}::date IS NOT NULL
               AND COALESCE(dl.voucher_date, dl.created_at::date) < ${from ?? '1970-01-01'}::date
              THEN (CASE WHEN dl.type = 'credit' THEN dl.amount ELSE -dl.amount END)
              ELSE 0
            END
          ), 0)::numeric AS opening_before,
          -- Range debits
          COALESCE(SUM(
            CASE
              WHEN (${from}::date IS NULL OR COALESCE(dl.voucher_date, dl.created_at::date) >= ${from ?? '1970-01-01'}::date)
               AND (${to}::date   IS NULL OR COALESCE(dl.voucher_date, dl.created_at::date) <= ${to   ?? '9999-12-31'}::date)
               AND dl.type = 'debit'
               AND COALESCE(dl.voucher_type, '') <> 'Opening'
              THEN dl.amount ELSE 0
            END
          ), 0)::numeric AS range_debits,
          -- Range credits
          COALESCE(SUM(
            CASE
              WHEN (${from}::date IS NULL OR COALESCE(dl.voucher_date, dl.created_at::date) >= ${from ?? '1970-01-01'}::date)
               AND (${to}::date   IS NULL OR COALESCE(dl.voucher_date, dl.created_at::date) <= ${to   ?? '9999-12-31'}::date)
               AND dl.type = 'credit'
               AND COALESCE(dl.voucher_type, '') <> 'Opening'
              THEN dl.amount ELSE 0
            END
          ), 0)::numeric AS range_credits
        FROM dealer_ledger dl
        WHERE dl.dealer_id = ${id}
      `;
   
      const staticOpening = parseFloat(dealer.static_opening_balance);
      const openingBefore = parseFloat(agg?.opening_before ?? "0");
      const rangeDebits   = parseFloat(agg?.range_debits ?? "0");
      const rangeCredits  = parseFloat(agg?.range_credits ?? "0");
      const creditLimit   = parseFloat(dealer.credit_limit);
   
      // Opening balance shown at the top of the range:
      //   = static opening (set by accountant) + net of all ledger
      //     rows before the range
      // If no `from` is set, opening_before = 0 so this reduces to just
      // the static opening.
      const openingBalance = staticOpening + openingBefore;
   
      // Closing = opening + (credits - debits) within the range.
      const closingBalance = openingBalance + rangeCredits - rangeDebits;
   
      // Available credit = credit limit - current outstanding.
      // Outstanding = negative closing balance (if closing < 0 the dealer
      // owes us; if closing > 0 we hold a credit for them).
      const outstanding    = closingBalance < 0 ? Math.abs(closingBalance) : 0;
      const availableCredit = Math.max(0, creditLimit - outstanding);
   
      return reply.send({
        dealer: {
          id: dealer.id,
          name: dealer.name,
          code: dealer.code,
        },
        period: {
          from: from,
          to:   to,
        },
        summary: {
          openingBalance:  Number(openingBalance.toFixed(2)),
          totalDebits:     Number(rangeDebits.toFixed(2)),
          totalCredits:    Number(rangeCredits.toFixed(2)),
          closingBalance:  Number(closingBalance.toFixed(2)),
          creditLimit:     Number(creditLimit.toFixed(2)),
          availableCredit: Number(availableCredit.toFixed(2)),
        },
      });
    }
  );

  // ═══════════════════════════════════════════════════════════════
  // GET /api/v1/dealer/profile — dealer's own profile (dealer auth)
  // ═══════════════════════════════════════════════════════════════
  app.get(
    "/api/v1/dealer/profile",
    { preHandler: [dealerAuth] },
    async (request, reply) => {
      const dealerId = (request as unknown as { dealer: { dealerId: string } })
        .dealer.dealerId;
        const [dealer] = await pgClient`
        SELECT d.*,
               z.name AS zone_name,
               COALESCE(w.balance, 0) AS wallet_balance,
               COALESCE((
                 SELECT SUM(o.grand_total) FROM orders o
                  WHERE o.dealer_id = d.id
                    AND o.payment_mode = 'credit'
                    AND o.status NOT IN ('cancelled','delivered')
               ), 0) AS credit_outstanding
        FROM dealers d
        JOIN zones z ON z.id = d.zone_id
        LEFT JOIN dealer_wallets w ON w.dealer_id = d.id
        WHERE d.id = ${dealerId} AND d.deleted_at IS NULL LIMIT 1
      `;
      if (!dealer) return reply.status(404).send({ error: "Not found" });
      return reply.send({ dealer });
    },
  );
}
