// apps/api/src/routes/admin-notifications.ts
// ═══════════════════════════════════════════════════════════════════════
// Staff notifications (the admin web's bell) and product demand (0086)
//
//   GET  /api/v1/admin-notifications                latest for my role + unread count
//   POST /api/v1/admin-notifications/:id/read
//   POST /api/v1/admin-notifications/read-all
//
//   GET  /api/v1/product-demand        ?from&to&status=open|all   per product,
//                                       with the dealers who asked
//   POST /api/v1/product-demand/resolve { ids: uuid[] }
//
//   POST /api/v1/dealer/products/:productId/notify-demand   (dealer app)
//   GET  /api/v1/dealer/demand-requests                     today's, for the app
//
// A dealer's "Notify" on an out-of-stock product records one request per
// dealer, product and IST day (a repeat tap bumps `taps`) and raises a
// staff notification the first time that day.
// ═══════════════════════════════════════════════════════════════════════
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pgClient } from "../lib/db.js";
import { adminAuth, requireRole } from "../middleware/admin-auth.js";
import { dealerAuth } from "../middleware/dealer-auth.js";
import { isoDate, istToday } from "../lib/ist-date.js";
import { NOTIFY_ROLES, notifyStaffSafe } from "../lib/admin-notifications.js";

export async function adminNotificationRoutes(app: FastifyInstance) {
  // ── Bell ──
  app.get(
    "/api/v1/admin-notifications",
    { preHandler: [adminAuth] },
    async (request, reply) => {
      const { userId, role } = request.admin!;
      // super_admin sees everything; everyone else what names their role.
      const rows = await pgClient`
        SELECT n.id, n.kind, n.title, n.body, n.link, n.created_at AS "createdAt",
               (r.user_id IS NOT NULL) AS read
          FROM admin_notifications n
          LEFT JOIN admin_notification_reads r ON r.notification_id = n.id AND r.user_id = ${userId}::uuid
         WHERE n.created_at > now() - interval '30 days'
           AND (${role} = 'super_admin' OR ${role} = ANY(n.roles))
         ORDER BY n.created_at DESC
         LIMIT 50
      `;
      const [c] = await pgClient`
        SELECT count(*)::int AS n
          FROM admin_notifications n
         WHERE n.created_at > now() - interval '30 days'
           AND (${role} = 'super_admin' OR ${role} = ANY(n.roles))
           AND NOT EXISTS (SELECT 1 FROM admin_notification_reads r
                            WHERE r.notification_id = n.id AND r.user_id = ${userId}::uuid)
      ` as any[];
      return reply.send({ data: rows, unread: c?.n ?? 0 });
    }
  );

  app.post(
    "/api/v1/admin-notifications/:id/read",
    { preHandler: [adminAuth] },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      await pgClient`
        INSERT INTO admin_notification_reads (notification_id, user_id)
        VALUES (${id}::uuid, ${request.admin!.userId}::uuid)
        ON CONFLICT DO NOTHING
      `;
      return reply.send({ ok: true });
    }
  );

  app.post(
    "/api/v1/admin-notifications/read-all",
    { preHandler: [adminAuth] },
    async (request, reply) => {
      const { userId, role } = request.admin!;
      await pgClient`
        INSERT INTO admin_notification_reads (notification_id, user_id)
        SELECT n.id, ${userId}::uuid
          FROM admin_notifications n
         WHERE n.created_at > now() - interval '30 days'
           AND (${role} = 'super_admin' OR ${role} = ANY(n.roles))
        ON CONFLICT DO NOTHING
      `;
      return reply.send({ ok: true });
    }
  );

  // ── Product demand (staff) ──
  app.get(
    "/api/v1/product-demand",
    { preHandler: [adminAuth, requireRole("demand.view")] },
    async (request, reply) => {
      const today = istToday();
      const q = z.object({
        from: isoDate.optional(),
        to: isoDate.optional(),
        status: z.enum(["open", "all"]).optional(),
      }).parse(request.query);
      const from = q.from ?? today;
      const to = q.to ?? today;
      const openOnly = (q.status ?? "open") === "open";
      const rows = await pgClient`
        SELECT d.id, d.request_date::text AS "requestDate", d.taps,
               d.created_at AS "createdAt", d.updated_at AS "updatedAt",
               d.resolved_at AS "resolvedAt", ru.name AS "resolvedByName",
               p.id AS "productId", p.code AS "productCode",
               COALESCE(NULLIF(trim(p.report_alias), ''), p.name) AS "productName",
               COALESCE(c.name, '') AS "categoryName",
               dl.id AS "dealerId", dl.code AS "dealerCode", dl.name AS "dealerName",
               split_part(dl.phone, ':deleted:', 1) AS "dealerPhone",
               COALESCE(z.name, '') AS taluka, r.code AS "routeCode"
          FROM product_demand_requests d
          JOIN products p  ON p.id = d.product_id
          LEFT JOIN categories c ON c.id = p.category_id
          JOIN dealers dl  ON dl.id = d.dealer_id
          LEFT JOIN zones z  ON z.id = dl.zone_id
          LEFT JOIN routes r ON r.id = dl.route_id
          LEFT JOIN users ru ON ru.id = d.resolved_by
         WHERE d.request_date >= ${from}::date AND d.request_date <= ${to}::date
           AND (${!openOnly} OR d.resolved_at IS NULL)
         ORDER BY p.sort_order, p.name, d.created_at
      ` as any[];

      // One block per product, its dealers inside.
      const byProduct = new Map<string, any>();
      for (const r of rows) {
        const cur = byProduct.get(r.productId) ?? {
          productId: r.productId, productCode: r.productCode, productName: r.productName,
          categoryName: r.categoryName, dealerCount: 0, taps: 0, open: 0, requests: [] as any[],
        };
        cur.dealerCount += 1;
        cur.taps += Number(r.taps) || 0;
        if (!r.resolvedAt) cur.open += 1;
        cur.requests.push({
          id: r.id, requestDate: r.requestDate, taps: r.taps, createdAt: r.createdAt, updatedAt: r.updatedAt,
          resolvedAt: r.resolvedAt, resolvedByName: r.resolvedByName,
          dealerId: r.dealerId, dealerCode: r.dealerCode, dealerName: r.dealerName, dealerPhone: r.dealerPhone,
          taluka: r.taluka, routeCode: r.routeCode,
        });
        byProduct.set(r.productId, cur);
      }
      const products = Array.from(byProduct.values()).sort((a, b) => b.dealerCount - a.dealerCount);
      return reply.send({ from, to, status: openOnly ? "open" : "all", products });
    }
  );

  app.post(
    "/api/v1/product-demand/resolve",
    { preHandler: [adminAuth, requireRole("demand.manage")] },
    async (request, reply) => {
      const body = z.object({ ids: z.array(z.string().uuid()).min(1).max(500) }).parse(request.body);
      const res = await pgClient`
        UPDATE product_demand_requests
           SET resolved_at = now(), resolved_by = ${request.admin!.userId}::uuid, updated_at = now()
         WHERE id = ANY(string_to_array(${body.ids.join(",")}, ',')::uuid[]) AND resolved_at IS NULL
      `;
      return reply.send({ resolved: res.count });
    }
  );

  // ── Dealer app ──
  app.post(
    "/api/v1/dealer/products/:productId/notify-demand",
    { preHandler: [dealerAuth] },
    async (request, reply) => {
      const { productId } = z.object({ productId: z.string().uuid() }).parse(request.params);
      const dealerId = request.dealer!.dealerId;
      const today = istToday();

      const [p] = await pgClient`
        SELECT id, COALESCE(NULLIF(trim(report_alias), ''), name) AS name
          FROM products WHERE id = ${productId}::uuid AND deleted_at IS NULL
      ` as any[];
      if (!p) return reply.status(404).send({ error: "Product not found" });

      // xmax = 0 on a fresh insert: notify staff once per dealer/product/day.
      const [row] = await pgClient`
        INSERT INTO product_demand_requests (dealer_id, product_id, request_date)
        VALUES (${dealerId}::uuid, ${productId}::uuid, ${today}::date)
        ON CONFLICT (dealer_id, product_id, request_date) DO UPDATE
          SET taps = product_demand_requests.taps + 1, updated_at = now(), resolved_at = NULL, resolved_by = NULL
        RETURNING id, (xmax = 0) AS inserted
      ` as any[];

      if (row?.inserted) {
        const [d] = await pgClient`
          SELECT d.code, d.name, r.code AS route_code
            FROM dealers d LEFT JOIN routes r ON r.id = d.route_id
           WHERE d.id = ${dealerId}::uuid
        ` as any[];
        const who = [d?.code, d?.name].filter(Boolean).join(" ");
        await notifyStaffSafe(request.log, {
          kind: "product_demand",
          title: `Demand: ${p.name}`,
          body: `${who || "A dealer"}${d?.route_code ? ` (route ${d.route_code})` : ""} wants ${p.name}, which is out of stock in the app.`,
          link: "/sales/product-demand",
          roles: [...NOTIFY_ROLES.productDemand],
          refId: row.id,
        });
      }
      return reply.send({ ok: true, message: "The union has been told you need this product." });
    }
  );

  app.get(
    "/api/v1/dealer/demand-requests",
    { preHandler: [dealerAuth] },
    async (request, reply) => {
      const rows = await pgClient`
        SELECT product_id::text AS "productId"
          FROM product_demand_requests
         WHERE dealer_id = ${request.dealer!.dealerId}::uuid
           AND request_date = ${istToday()}::date
           AND resolved_at IS NULL
      ` as any[];
      return reply.send({ productIds: rows.map(r => r.productId) });
    }
  );
}
