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
   
      // ── 1. All active products ──
      const prodRows = await pgClient`
        SELECT p.id, p.code, p.report_alias, p.name,
               p.print_direction, p.packets_crate,
               p.pack_size, p.unit, p.sort_order,
               c.name AS category_name
          FROM products p
          JOIN categories c ON c.id = p.category_id
         WHERE p.deleted_at IS NULL
           AND p.available  = true
         ORDER BY p.sort_order, p.name
      `;
   
      // ── 2. Bucketing: 8 across max (milk + curd by sort_order) ──
      // filter by print_direction column as intended
      // const ACROSS_CAP = 12; // or remove .slice(0, ACROSS_CAP) entirely
      const acrossEligible = (prodRows as any[]).filter(
        p => (p.print_direction ?? "").trim().toLowerCase() === "across"
      );

      const acrossProducts = acrossEligible.map(p => ({
        id: p.id,
        code: p.code ?? "",
        reportAlias: p.report_alias ?? p.name,
        category: p.category_name,
        packetsCrate: Number(p.packets_crate) || 0,
        packSize: parseFloat(p.pack_size) || 0,
        unit: p.unit ?? "",
      }));
      const acrossIds = new Set(acrossProducts.map(p => p.id));
   
      const otherProducts = (prodRows as any[])
        .filter(p => !acrossIds.has(p.id))
        .map(p => ({
          id: p.id,
          code: p.code ?? "",
          reportAlias: p.report_alias ?? p.name,
          category: p.category_name,
          packetsCrate: Number(p.packets_crate) || 0,
          packSize: parseFloat(p.pack_size) || 0,
          unit: p.unit ?? "",
        }));
   
      type ProdMeta = {
        id: string; alias: string; packetsCrate: number;
        packSize: number; unit: string; sortOrder: number;
      };
      const productMeta = new Map<string, ProdMeta>();
      for (const p of prodRows as any[]) {
        productMeta.set(p.id, {
          id: p.id,
          alias: p.report_alias ?? p.name,
          packetsCrate: Number(p.packets_crate) || 0,
          packSize: parseFloat(p.pack_size) || 0,
          unit: p.unit ?? "",
          sortOrder: Number(p.sort_order) || 0,
        });
      }
   
      // ── 3. Batch metadata (if any) ──
      let batch: any = null;
      if (batchId) {
        const [b] = await pgClient`
          SELECT id, name, batch_number
            FROM batches
          WHERE id = ${batchId} AND deleted_at IS NULL
        `;
        if (b) batch = {
          id: b.id, name: b.name, batchNumber: b.batch_number,
        };
      }
   
      // ── 4. Routes that have any non-cancelled order on the date.
      //     Batch filter narrows the ROUTE SET via batch_routes junction
      //     (orders table has no batch_id). ──
      const routes = await pgClient`
        SELECT r.id, r.code, r.name,
               r.contractor_id, r.dispatch_time,
               ct.name           AS contractor_name,
               ct.vehicle_number AS vehicle_number,
               b.name            AS batch_name,
               b.batch_number    AS batch_code
          FROM routes r
          LEFT JOIN contractors ct ON ct.id = r.contractor_id AND ct.deleted_at IS NULL
          LEFT JOIN batches b      ON b.id = r.primary_batch_id AND b.deleted_at IS NULL
         WHERE r.deleted_at IS NULL
           AND (${batchId}::uuid IS NULL
                OR EXISTS (SELECT 1 FROM batch_routes br
                            WHERE br.route_id = r.id
                              AND br.batch_id = ${batchId ?? '00000000-0000-0000-0000-000000000000'}::uuid))
           AND EXISTS (
             SELECT 1
               FROM orders o
               JOIN dealers d ON d.id = o.dealer_id
              WHERE o.created_at::date = ${q.date}::date
                AND o.status != 'cancelled'
                AND d.route_id = r.id
           )
         ORDER BY r.code
      `;
   
      if ((routes as any[]).length === 0) {
        return reply.send({
          date: q.date,
          batch,
          acrossProducts,
          otherProducts,
          routes: [],
        });
      }
      const routeIds = (routes as any[]).map(r => r.id);
   
      // ── 5. Dealers on those routes ──
      // Pull position from dealer_routes for the dealer's primary route
      // so the printed sheet matches the delivery driver's actual path.
      const dealers = await pgClient`
      SELECT d.id, d.code, d.name, d.route_id,
            dr.position AS position
        FROM dealers d
        JOIN dealer_routes dr
          ON dr.dealer_id = d.id
        AND dr.route_id  = d.route_id      -- primary route only (matches existing filter)
      WHERE d.deleted_at IS NULL
        AND d.route_id = ANY(${routeIds}::uuid[])
      ORDER BY dr.route_id,
                dr.position NULLS LAST,
                d.code, d.name
      `;
   
      // ── 6. Order items for the day (no batch filter — routes are
      //     already pre-filtered by batch_routes above). ──
      const itemRows = await pgClient`
        SELECT o.id AS order_id, o.dealer_id, d.route_id,
               oi.product_id, oi.quantity::int AS qty,
               oi.line_total::numeric AS amount
          FROM orders o
          JOIN dealers d     ON d.id = o.dealer_id
          JOIN order_items oi ON oi.order_id = o.id
         WHERE o.created_at::date = ${q.date}::date
           AND o.status != 'cancelled'
           AND d.route_id = ANY(${routeIds}::uuid[])
      `;
   
      // ── 7. Aggregate per (route, dealer, product) and per (route, product) ──
      type DealerAgg = {
        id: string; code: string; name: string;
        acrossQty: Record<string, number>;
        othersItems: Array<{ productId: string; alias: string; qty: number; sortOrder: number }>;
        othersQty: number;
        netAmount: number;
        crates: number;
      };
      const byRoute = new Map<string, Map<string, DealerAgg>>();
      const routeProductAgg = new Map<string, Map<string, { qty: number; amount: number }>>();
   
      for (const r of routes as any[]) {
        byRoute.set(r.id, new Map());
        routeProductAgg.set(r.id, new Map());
      }
   
      for (const d of dealers as any[]) {
        byRoute.get(d.route_id)?.set(d.id, {
          id: d.id, code: d.code ?? "", name: d.name,
          acrossQty: Object.fromEntries(acrossProducts.map(p => [p.id, 0])),
          othersItems: [],
          othersQty: 0,
          netAmount: 0,
          crates: 0,
        });
      }
   
      for (const it of itemRows as any[]) {
        const dealer = byRoute.get(it.route_id)?.get(it.dealer_id);
        if (!dealer) continue;
        const meta = productMeta.get(it.product_id);
        if (!meta) continue;
   
        const qty = Number(it.qty) || 0;
        const amt = parseFloat(it.amount) || 0;
   
        const rmap = routeProductAgg.get(it.route_id)!;
        const cur = rmap.get(it.product_id) ?? { qty: 0, amount: 0 };
        cur.qty += qty;
        cur.amount = round2(cur.amount + amt);
        rmap.set(it.product_id, cur);
   
        if (acrossIds.has(it.product_id)) {
          dealer.acrossQty[it.product_id] = (dealer.acrossQty[it.product_id] ?? 0) + qty;
        } else {
          dealer.othersItems.push({
            productId: it.product_id,
            alias: meta.alias,
            qty,
            sortOrder: meta.sortOrder,
          });
          dealer.othersQty += qty;
        }
        dealer.netAmount = round2(dealer.netAmount + amt);
   
        if (meta.packetsCrate > 0) {
          dealer.crates += Math.round(qty / meta.packetsCrate);
        }
      }
   
      // ── 8. Shape per-route output ──
      const routesOut: any[] = [];
      for (const r of routes as any[]) {
        const map = byRoute.get(r.id)!;
        const allRows = Array.from(map.values());
        const activeRows = allRows.filter(d =>
          d.othersQty > 0 || Object.values(d.acrossQty).some(q => q > 0)
        );
        if (activeRows.length === 0) continue;
   
        activeRows.sort((a, b) =>
          (a.code || "").localeCompare(b.code || "")
          || a.name.localeCompare(b.name)
        );
   
        const customers = activeRows.map((d, idx) => {
          const collapsed = new Map<string, { alias: string; qty: number; sortOrder: number }>();
          for (const it of d.othersItems) {
            const cur = collapsed.get(it.productId);
            if (cur) cur.qty += it.qty;
            else collapsed.set(it.productId, { alias: it.alias, qty: it.qty, sortOrder: it.sortOrder });
          }
          const othersList = Array.from(collapsed.values())
            .filter(x => x.qty > 0)
            .sort((a, b) => a.sortOrder - b.sortOrder);
   
          return {
            sl: idx + 1,
            id: d.id,
            code: d.code,
            name: d.name,
            acrossQty: d.acrossQty,
            othersText: othersList.map(x => `${x.alias} × ${x.qty}`).join(", "),
            othersQty: d.othersQty,
            netAmount: round2(d.netAmount),
            crates: d.crates,
          };
        });
   
        const totals = {
          acrossQty: Object.fromEntries(
            acrossProducts.map(p => [
              p.id,
              customers.reduce((s, c) => s + (c.acrossQty[p.id] ?? 0), 0),
            ])
          ),
          othersQty:      customers.reduce((s, c) => s + c.othersQty, 0),
          netAmount:      round2(customers.reduce((s, c) => s + c.netAmount, 0)),
          crates:         customers.reduce((s, c) => s + c.crates, 0),
          totalAcrossQty: customers.reduce((s, c) =>
            s + Object.values(c.acrossQty).reduce((a: number, b: number) => a + b, 0), 0),
          totalAllQty:    customers.reduce((s, c) =>
            s + Object.values(c.acrossQty).reduce((a: number, b: number) => a + b, 0) + c.othersQty, 0),
        };
   
        // ── Abstract: per-product breakdown (across + others) ──
        const rmap = routeProductAgg.get(r.id)!;
        const abstractItems: any[] = [];
        for (const [pid, agg] of rmap.entries()) {
          if (agg.qty === 0) continue;
          const meta = productMeta.get(pid)!;
          const pc = meta.packetsCrate;
          let crates = 0, pktPlus = 0, pktMinus = 0;
          if (pc > 0) {
            crates = Math.round(agg.qty / pc);
            const diff = agg.qty - crates * pc;
            if (diff > 0) pktPlus = diff;
            else if (diff < 0) pktMinus = -diff;
          } else {
            pktPlus = agg.qty;
          }
          abstractItems.push({
            productId:    pid,
            alias:        meta.alias,
            sortOrder:    meta.sortOrder,
            packetsCrate: pc,
            packSize:     meta.packSize,
            unit:         meta.unit,
            crates,
            packets:      agg.qty,
            kgLtr:        round2(agg.qty * meta.packSize),
            amount:       agg.amount,
            pktPlus,
            pktMinus,
          });
        }
        abstractItems.sort((a, b) => a.sortOrder - b.sortOrder);
   
        const abstract = {
          items: abstractItems,
          totals: {
            packets:  abstractItems.reduce((s, i) => s + i.packets, 0),
            kgLtr:    round2(abstractItems.reduce((s, i) => s + i.kgLtr, 0)),
            amount:   round2(abstractItems.reduce((s, i) => s + i.amount, 0)),
            crates:   abstractItems.reduce((s, i) => s + i.crates, 0),
            pktPlus:  abstractItems.reduce((s, i) => s + i.pktPlus, 0),
            pktMinus: abstractItems.reduce((s, i) => s + i.pktMinus, 0),
          },
        };
   
        routesOut.push({
          id: r.id,
          code: r.code,
          name: r.name,
          contractor: {
            id:            r.contractor_id ?? null,
            name:          r.contractor_name ?? null,
            vehicleNumber: r.vehicle_number ?? null,
          },
          dispatchTime: r.dispatch_time ?? null,
          batchName: r.batch_name ?? null,
          batchCode: r.batch_code ?? null,
          customers,
          totals,
          abstract,
        });
      }
   
      return reply.send({
        date: q.date,
        batch,
        acrossProducts,
        otherProducts,
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