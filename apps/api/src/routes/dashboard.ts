import type { FastifyInstance } from "fastify";
import { pgClient } from "../lib/db.js";
import { adminAuth, requireRole } from "../middleware/admin-auth.js";

export async function dashboardRoutes(app: FastifyInstance) {
  // GET /api/v1/dashboard/summary — aggregate stats for the Dashboard
  // Returns: todayOrders, todayRevenue, activeCustomers, pendingIndents, stockAlerts,
  //          recentOrders, stockOverview, zoneBreakdown
  app.get(
    "/api/v1/dashboard/summary",
    { preHandler: [adminAuth, requireRole("dashboard")] },
    async (request, reply) => {
      const today = new Date().toISOString().slice(0, 10);

      // Run all queries in parallel for speed
      const [
        todayStats,
        pendingIndents,
        activeCustomers,
        stockAlerts,
        recentOrders,
        stockOverview,
        zoneBreakdown,
        totalWallet,
        directSalesToday,
      ] = await Promise.all([
        // Today's order count + revenue
        pgClient`
          SELECT count(*)::int AS order_count,
                 COALESCE(sum(grand_total), 0)::numeric AS revenue,
                 COALESCE(sum(item_count), 0)::int AS items_sold
          FROM orders
          WHERE created_at::date = ${today}::date
            AND status != 'cancelled'
        `.then(r => r[0]),

        // Pending indents count
        pgClient`
          SELECT count(*)::int AS count FROM orders
          WHERE status = 'pending'
        `.then(r => r[0]),

        // Active dealers count
        pgClient`
          SELECT count(*)::int AS count FROM dealers
          WHERE deleted_at IS NULL AND active = true
        `.then(r => r[0]),

        // Stock alerts (low + critical + out of stock)
        pgClient`
          SELECT
            count(*) FILTER (WHERE stock = 0)::int AS out_of_stock,
            count(*) FILTER (WHERE stock > 0 AND stock <= critical_stock_threshold)::int AS critical,
            count(*) FILTER (WHERE stock > critical_stock_threshold AND stock <= low_stock_threshold)::int AS low
          FROM products WHERE deleted_at IS NULL
        `.then(r => r[0]),

        // Recent 5 orders
        pgClient`
          SELECT o.id, o.status, o.grand_total, o.item_count, o.created_at,
                 d.name AS dealer_name, z.name AS zone_name
          FROM orders o
          JOIN dealers d ON d.id = o.dealer_id
          JOIN zones z ON z.id = o.zone_id
          ORDER BY o.created_at DESC
          LIMIT 5
        `,

        // Stock overview — top 10 products by stock status
        pgClient`
          SELECT p.id, p.name, p.icon, p.stock, p.unit,
                 p.low_stock_threshold, p.critical_stock_threshold,
                 c.name AS category_name,
                 CASE
                   WHEN p.stock = 0 THEN 'out_of_stock'
                   WHEN p.stock <= p.critical_stock_threshold THEN 'critical'
                   WHEN p.stock <= p.low_stock_threshold THEN 'low'
                   ELSE 'healthy'
                 END AS stock_status
          FROM products p
          JOIN categories c ON c.id = p.category_id
          WHERE p.deleted_at IS NULL
          ORDER BY p.stock ASC
          LIMIT 10
        `,

        // Orders by zone today
        pgClient`
          SELECT z.name, z.slug, z.color, count(o.id)::int AS order_count,
                 COALESCE(sum(o.grand_total), 0)::numeric AS revenue
          FROM zones z
          LEFT JOIN orders o ON o.zone_id = z.id AND o.created_at::date = ${today}::date AND o.status != 'cancelled'
          WHERE z.active = true
          GROUP BY z.id
          ORDER BY z.name
        `,

        // Total wallet balance across all dealers
        pgClient`
          SELECT COALESCE(sum(balance), 0)::numeric AS total FROM dealer_wallets
        `.then(r => r[0]),

        // Today's direct sales count + amount
        pgClient`
          SELECT count(*)::int AS count,
                 COALESCE(sum(grand_total), 0)::numeric AS revenue
          FROM direct_sales
          WHERE sale_date = ${today}::date
        `.then(r => r[0]),
      ]);

      return reply.send({
        today: {
          orderCount: todayStats?.order_count ?? 0,
          revenue: parseFloat(todayStats?.revenue ?? "0"),
          itemsSold: todayStats?.items_sold ?? 0,
          directSalesCount: directSalesToday?.count ?? 0,
          directSalesRevenue: parseFloat(directSalesToday?.revenue ?? "0"),
        },
        pendingIndents: pendingIndents?.count ?? 0,
        activeCustomers: activeCustomers?.count ?? 0,
        totalWalletBalance: parseFloat(totalWallet?.total ?? "0"),
        stockAlerts: {
          outOfStock: stockAlerts?.out_of_stock ?? 0,
          critical: stockAlerts?.critical ?? 0,
          low: stockAlerts?.low ?? 0,
        },
        recentOrders,
        stockOverview,
        zoneBreakdown,
      });
    }
  );
}
