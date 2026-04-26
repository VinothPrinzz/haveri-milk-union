import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import sensible from "@fastify/sensible";
import { env } from "./lib/env.js";

// Route modules — Phase 1
import { authRoutes } from "./routes/auth.js";
import { windowRoutes } from "./routes/window.js";
import { productRoutes } from "./routes/products.js";
import { orderRoutes } from "./routes/orders.js";
import { dealerRoutes } from "./routes/dealers.js";
import { inventoryRoutes } from "./routes/inventory.js";
import { distributionRoutes } from "./routes/distribution.js";
import { cancellationRoutes } from "./routes/cancellations.js";
import { financeRoutes } from "./routes/finance.js";
import { crudRoutes } from "./routes/crud.js";
import { systemRoutes } from "./routes/system.js";
import { dealerAppRoutes } from "./routes/dealer-app.js";
import { dealerNotificationsRoutes } from "./routes/dealer-notifications.js";

// Route modules — Phase 2
import { dashboardRoutes } from "./routes/dashboard.js";
import { contractorRoutes } from "./routes/contractors.js";
import { batchRoutes } from "./routes/batches.js";
import { priceChartRoutes } from "./routes/price-chart.js";
import { directSalesRoutes } from "./routes/direct-sales.js";
import { routeSheetRoutes } from "./routes/route-sheets.js";
import { salesReportRoutes } from "./routes/sales-reports.js";
import { dispatchSheetRoutes }   from "./routes/dispatch-sheet.js";

import { zoneRoutes } from "./routes/zones.js";
import { reportsRoutes } from "./routes/reports.js";

const app = Fastify({
  logger: {
    level: env.NODE_ENV === "production" ? "info" : "debug",
    ...(env.NODE_ENV === "development"
      ? { transport: { target: "pino-pretty", options: { colorize: true } } }
      : {}),
  },
});

// ── Plugins ──
await app.register(cors, {
  origin: env.NODE_ENV === "production"
    ? ["https://erp.haverimunion.coop"]
    : true,
  credentials: true,
});

await app.register(cookie, {
  secret: env.SESSION_SECRET,
});

await app.register(sensible);

// ── Global error handler ──
app.setErrorHandler((error, request, reply) => {
  if (error.name === "ZodError") {
    return reply.status(400).send({
      error: "Validation Error",
      message: "Invalid request data",
      details: (error as any).issues,
    });
  }

  if (error.validation) {
    return reply.status(400).send({
      error: "Validation Error",
      message: error.message,
    });
  }

  request.log.error(error);

  return reply.status(error.statusCode ?? 500).send({
    error: error.name || "Internal Server Error",
    message:
      env.NODE_ENV === "production"
        ? "Something went wrong"
        : error.message,
  });
});

// ── Health Check ──
app.get("/api/v1/health", async () => ({
  status: "ok",
  timestamp: new Date().toISOString(),
  version: "0.0.2",
}));

// ── Register All Routes ──

// Core (Phase 1)
await app.register(authRoutes);
await app.register(windowRoutes);
await app.register(productRoutes);
await app.register(orderRoutes);
await app.register(dealerRoutes);
await app.register(inventoryRoutes);
await app.register(distributionRoutes);

// Phase 1 additions
await app.register(cancellationRoutes);   // approve/reject cancellations with wallet refund
await app.register(financeRoutes);         // invoices, reports, admin-placed orders
await app.register(crudRoutes);            // categories, price revision, route update, dispatch status
await app.register(systemRoutes);          // users CRUD, registrations, notification config
await app.register(dealerAppRoutes);       // banners, invoices/my, reorder

// Phase 2 — Marketing Module
await app.register(dashboardRoutes);       // GET /dashboard/summary — aggregate stats
await app.register(contractorRoutes);      // contractors CRUD
await app.register(batchRoutes);           // batches CRUD + batch↔route associations
await app.register(priceChartRoutes);      // rate categories + price chart CRUD
await app.register(directSalesRoutes);     // gate pass, cash customer, returns
await app.register(routeSheetRoutes);      // route sheet generation + management
await app.register(reportsRoutes);           // Route Sheet + Gate Pass Report
await app.register(salesReportRoutes);     // 9 sales report endpoints
await app.register(dispatchSheetRoutes);

// dealer notification
await app.register(dealerNotificationsRoutes);

await app.register(zoneRoutes);           // zones CRUD

// ── Start Server ──
try {
  const address = await app.listen({
    port: env.API_PORT,
    host: env.API_HOST,
  });
  app.log.info(`🚀 API server running at ${address}`);
  app.log.info(`   Health: ${address}/api/v1/health`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

export default app;
