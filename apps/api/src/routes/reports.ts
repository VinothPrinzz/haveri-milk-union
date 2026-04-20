import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pgClient } from "../lib/db.js";
import { adminAuth, requireRole } from "../middleware/admin-auth.js";
import { paginationMeta, offsetFromPage } from "../lib/pagination.js";

// Reports need larger page sizes than the shared paginationSchema allows (max 100).
// Using a local schema with max(1000) because report tables can legitimately render
// hundreds of rows per visual page (Gate Pass, Adhoc).
const reportPagination = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});

export async function reportsRoutes(app: FastifyInstance) {
  // ════════════════════════════════════════════
  // A1. Route Sheet — 1 page per active route
  // Filters: batch (optional), date (required)
  // ════════════════════════════════════════════
  app.get(
    "/api/v1/reports/route-sheet",
    { preHandler: [adminAuth, requireRole("reports.view")] },
    async (request, reply) => {
      const qs = z.object({
        date: z.string(),
        batchId: z.string().uuid().optional(),
      });
      const q = qs.parse(request.query);
      const batchId = q.batchId ?? null;

      // Active products split by print_direction
      const prodRows = await pgClient`
        SELECT id, code, report_alias, name, print_direction, packets_crate, sort_order
        FROM products
        WHERE deleted_at IS NULL AND available = true
        ORDER BY sort_order, name
      `;
      const acrossProducts = (prodRows as any[])
        .filter(p => (p.print_direction ?? "Across") === "Across")
        .map(p => ({
          id: p.id,
          code: p.code ?? "",
          reportAlias: p.report_alias ?? p.name,
          packetsCrate: Number(p.packets_crate) || 20,
        }));
      const downProducts = (prodRows as any[])
        .filter(p => p.print_direction === "Down")
        .map(p => ({
          id: p.id,
          code: p.code ?? "",
          reportAlias: p.report_alias ?? p.name,
        }));
      const downProdIds = new Set(downProducts.map(p => p.id));

      // Batch metadata (if any)
      let batch: any = null;
      if (batchId) {
        const [b] = await pgClient`
          SELECT id, name, batch_number FROM batches WHERE id = ${batchId} AND deleted_at IS NULL
        `;
        if (b) batch = { id: b.id, name: b.name, batchNumber: b.batch_number };
      }

      // Routes (active) with contractor info — UPDATED with primary_batch_id and COALESCE
      const routes = await pgClient`
        SELECT 
          r.id, r.code, r.name, r.active, r.zone_id,
          r.contractor_id, r.primary_batch_id,
          -- Resolved dispatch time: prefer batch's, fall back to route's own
          COALESCE(b.dispatch_time::text, r.dispatch_time) AS dispatch_time,
          b.name  AS batch_name,
          b.batch_number AS batch_code,
          z.name  AS zone_name,
          ct.name AS contractor_name,
          ct.vehicle_number AS vehicle_number
        FROM routes r
        LEFT JOIN batches b ON b.id = r.primary_batch_id AND b.deleted_at IS NULL
        LEFT JOIN zones z ON z.id = r.zone_id
        LEFT JOIN contractors ct ON ct.id = r.contractor_id AND ct.deleted_at IS NULL
        WHERE r.deleted_at IS NULL AND r.active = true
        ORDER BY r.code
      `;

      const routeIds = (routes as any[]).map(r => r.id);
      if (routeIds.length === 0) {
        return reply.send({
          date: q.date, batch, acrossProducts, downProducts, routes: [],
        });
      }

      // Dealers on each route (via dealers.route_id — primary route)
      const dealers = await pgClient`
        SELECT d.id, d.code, d.name, d.route_id
        FROM dealers d
        WHERE d.deleted_at IS NULL AND d.route_id = ANY(${routeIds}::uuid[])
        ORDER BY d.code, d.name
      `;

      // Order items for the day, filtered optionally by batch
      const itemRows = batchId
        ? await pgClient`
            SELECT o.id AS order_id, o.dealer_id, d.route_id,
                   oi.product_id, oi.quantity::int AS qty,
                   oi.line_total::numeric AS amount
            FROM orders o
            JOIN dealers d ON d.id = o.dealer_id
            JOIN order_items oi ON oi.order_id = o.id
            WHERE o.created_at::date = ${q.date}::date
              AND o.status != 'cancelled'
              AND d.route_id = ANY(${routeIds}::uuid[])
              AND o.batch_id = ${batchId}::uuid
          `
        : await pgClient`
            SELECT o.id AS order_id, o.dealer_id, d.route_id,
                   oi.product_id, oi.quantity::int AS qty,
                   oi.line_total::numeric AS amount
            FROM orders o
            JOIN dealers d ON d.id = o.dealer_id
            JOIN order_items oi ON oi.order_id = o.id
            WHERE o.created_at::date = ${q.date}::date
              AND o.status != 'cancelled'
              AND d.route_id = ANY(${routeIds}::uuid[])
          `;

      // Index: routeId → dealerId → { product_id → qty }, amount
      type DealerAgg = {
        id: string; code: string; name: string;
        acrossQty: Record<string, number>;
        downItems: Array<{ productId: string; alias: string; qty: number }>;
        othersQty: number;
        netAmount: number;
      };
      const byRoute = new Map<string, Map<string, DealerAgg>>();
      for (const r of routes as any[]) byRoute.set(r.id, new Map());

      const aliasById = new Map(
        (prodRows as any[]).map(p => [p.id, p.report_alias ?? p.name])
      );

      for (const d of dealers as any[]) {
        const dealerAgg: DealerAgg = {
          id: d.id, code: d.code ?? "", name: d.name,
          acrossQty: Object.fromEntries(acrossProducts.map(p => [p.id, 0])),
          downItems: [],
          othersQty: 0,
          netAmount: 0,
        };
        byRoute.get(d.route_id)?.set(d.id, dealerAgg);
      }

      for (const it of itemRows as any[]) {
        const dealerMap = byRoute.get(it.route_id);
        const dealer = dealerMap?.get(it.dealer_id);
        if (!dealer) continue;
        const qty = Number(it.qty) || 0;
        const amt = parseFloat(it.amount) || 0;
        if (downProdIds.has(it.product_id)) {
          dealer.downItems.push({
            productId: it.product_id,
            alias: aliasById.get(it.product_id) ?? "",
            qty,
          });
          dealer.othersQty += qty;
        } else {
          dealer.acrossQty[it.product_id] = (dealer.acrossQty[it.product_id] ?? 0) + qty;
        }
        dealer.netAmount = round2(dealer.netAmount + amt);
      }

      // Shape each route
      const routesOut = (routes as any[]).map(r => {
        const map = byRoute.get(r.id)!;
        const rows = Array.from(map.values());
        rows.sort((a, b) => (a.code || "").localeCompare(b.code || "") || a.name.localeCompare(b.name));

        const pktPerCrate = 20;
        const customers = rows.map((d, idx) => {
          const totalQty =
            Object.values(d.acrossQty).reduce((s, q) => s + q, 0) + d.othersQty;
          const crates = Math.ceil(totalQty / pktPerCrate);
          return {
            sl: idx + 1,
            id: d.id,
            code: d.code,
            name: d.name,
            acrossQty: d.acrossQty,
            othersText: d.downItems
              .filter(x => x.qty > 0)
              .map(x => `${x.alias} x ${x.qty}`)
              .join(", "),
            othersQty: d.othersQty,
            netAmount: round2(d.netAmount),
            crates,
          };
        });

        const totals = {
          acrossQty: Object.fromEntries(
            acrossProducts.map(p => [p.id, customers.reduce((s, c) => s + (c.acrossQty[p.id] ?? 0), 0)])
          ),
          othersQty: customers.reduce((s, c) => s + c.othersQty, 0),
          netAmount: round2(customers.reduce((s, c) => s + c.netAmount, 0)),
          crates: customers.reduce((s, c) => s + c.crates, 0),
        };

        return {
          id: r.id,
          code: r.code,
          name: r.name,
          contractor: {
            id: r.contractor_id ?? null,
            name: r.contractor_name ?? null,
            vehicleNumber: r.vehicle_number ?? null,
          },
          dispatchTime: r.dispatch_time ?? null,
          batchName: r.batch_name ?? null,
          batchCode: r.batch_code ?? null,
          customers,
          totals,
        };
      });

      return reply.send({
        date: q.date,
        batch,
        acrossProducts,
        downProducts,
        routes: routesOut,
      });
    }
  );

  // ════════════════════════════════════════════
  // A2. Gate Pass Sales Report — paginated list
  // ════════════════════════════════════════════
  app.get(
    "/api/v1/reports/gate-pass",
    { preHandler: [adminAuth, requireRole("reports.view")] },
    async (request, reply) => {
      const qs = reportPagination.extend({
        from: z.string(),
        to: z.string(),
      });
      const q = qs.parse(request.query);
      const offset = offsetFromPage(q.page, q.limit);

      const rows = await pgClient`
        SELECT ds.id,
               ds.gp_no,
               ds.sale_date,
               d.name    AS agent_name,
               r.name    AS route_name,
               ds.grand_total::numeric AS amount,
               COALESCE(
                 (SELECT json_agg(json_build_object(
                     'name', COALESCE(p.report_alias, p.name),
                     'qty',  dsi.quantity::int
                   ) ORDER BY p.sort_order)
                  FROM direct_sale_items dsi
                  JOIN products p ON p.id = dsi.product_id
                  WHERE dsi.direct_sale_id = ds.id),
                 '[]'::json
               ) AS items
        FROM direct_sales ds
        JOIN dealers d ON ds.customer_type = 'agent' AND d.id = ds.customer_id
        LEFT JOIN routes r ON r.id = ds.route_id
        WHERE ds.customer_type = 'agent'
          AND ds.sale_date >= ${q.from}::date
          AND ds.sale_date <= ${q.to}::date
        ORDER BY ds.sale_date DESC, ds.gp_no
        LIMIT ${q.limit} OFFSET ${offset}
      `;

      const [countRow] = await pgClient`
        SELECT count(*)::int AS count, COALESCE(sum(grand_total),0)::numeric AS total_amount
        FROM direct_sales
        WHERE customer_type = 'agent'
          AND sale_date >= ${q.from}::date
          AND sale_date <= ${q.to}::date
      `;

      const mapped = (rows as any[]).map(r => {
        const items = Array.isArray(r.items) ? r.items : [];
        return {
          gpNo: r.gp_no ?? "",
          date: new Date(r.sale_date).toISOString().slice(0, 10),
          agentName: r.agent_name ?? "",
          routeName: r.route_name ?? "",
          items,
          itemsText: items
            .filter((x: any) => (x.qty ?? 0) > 0)
            .map((x: any) => `${x.name} x ${x.qty}`)
            .join(", "),
          amount: round2(parseFloat(r.amount) || 0),
        };
      });

      return reply.send({
        rows: mapped,
        totalAmount: round2(parseFloat((countRow as any)?.total_amount ?? 0)),
        ...paginationMeta((countRow as any)?.count ?? 0, q.page, q.limit),
      });
    }
  );
}

function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}