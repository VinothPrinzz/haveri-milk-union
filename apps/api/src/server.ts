import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import sensible from "@fastify/sensible";
import { env } from "./lib/env.js";

// ── Route Modules ─────────────────────────────────────
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

// Phase 2
import { dashboardRoutes } from "./routes/dashboard.js";
import { contractorRoutes } from "./routes/contractors.js";
import { batchRoutes } from "./routes/batches.js";
import { priceChartRoutes } from "./routes/price-chart.js";
import { directSalesRoutes } from "./routes/direct-sales.js";
import { routeSheetRoutes } from "./routes/route-sheets.js";
import { salesReportRoutes } from "./routes/sales-reports.js";
import { dispatchSheetRoutes } from "./routes/dispatch-sheet.js";
import { zoneRoutes } from "./routes/zones.js";
import { reportsRoutes } from "./routes/reports.js";
import { vipContactsRoutes } from "./routes/vip-contacts.js";
import { employeesRoutes }    from "./routes/employees.js";

// // ▼▼▼ DUAL-DB (Temporarily Commented Out) ▼▼▼
// import {
//   dbStatusRoutes,
//   registerDbFailoverAuditHook,
// } from "./routes/db-status.js";
// import { dbReconciliationRoutes } from "./routes/db-reconciliation.js";
// import { dbPollingReplicationRoutes } from "./routes/db-polling-replication.js";
// import { getDbManager } from "@hmu/db";
// ▲▲▲ DUAL-DB ▲▲▲

const app = Fastify({
  logger: {
    level: env.NODE_ENV === "production" ? "info" : "debug",
    ...(env.NODE_ENV === "development"
      ? { transport: { target: "pino-pretty", options: { colorize: true } } }
      : {}),
  },
});

// ── Plugins ───────────────────────────────────────────
await app.register(cors, {
  origin: env.NODE_ENV === "production"
    ? ["https://erp.haverimunion.coop"]
    : true,
  credentials: true,
  allowedHeaders: ["Content-Type", "x-session-token"],
});

await app.register(cookie, {
  secret: env.SESSION_SECRET,
});

await app.register(sensible);

// ── Global Error Handler ─────────────────────────────
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

// ── Health Check ─────────────────────────────────────
app.get("/api/v1/health", async () => ({
  status: "ok",
  timestamp: new Date().toISOString(),
  version: "0.0.2",
}));

// // ▼▼▼ DUAL-DB (Temporarily Commented Out) ▼▼▼
// await app.register(dbStatusRoutes);
// await app.register(dbReconciliationRoutes);
// await app.register(dbPollingReplicationRoutes);
// registerDbFailoverAuditHook();

// const dbManager = getDbManager();
// if (dbManager) {
//   dbManager.on("event", (evt) => {
//     app.log.warn(
//       {
//         kind: evt.kind,
//         from: evt.fromRole,
//         to: evt.toRole,
//         reason: evt.reason,
//         error: evt.error,
//       },
//       "[db] failover event"
//     );
//   });
//   app.log.info(
//     `[db] Dual-DB manager active. Currently on: ${dbManager.getActiveRole()}`
//   );
// } else {
//   app.log.info("[db] Single-DB mode.");
// }
// ▲▲▲ DUAL-DB ▲▲▲

// ── Register All Routes ───────────────────────────────
// Phase 1 - Core
await app.register(authRoutes);
await app.register(windowRoutes);
await app.register(productRoutes);
await app.register(orderRoutes);
await app.register(dealerRoutes);
await app.register(inventoryRoutes);
await app.register(distributionRoutes);

// Phase 1 Additions
await app.register(cancellationRoutes);
await app.register(financeRoutes);
await app.register(crudRoutes);
await app.register(systemRoutes);
await app.register(dealerAppRoutes);

// Phase 2
await app.register(dashboardRoutes);
await app.register(contractorRoutes);
await app.register(batchRoutes);
await app.register(priceChartRoutes);
await app.register(directSalesRoutes);
await app.register(routeSheetRoutes);
await app.register(salesReportRoutes);
await app.register(dispatchSheetRoutes);
await app.register(dealerNotificationsRoutes);
await app.register(zoneRoutes);
await app.register(reportsRoutes);
await app.register(vipContactsRoutes);
await app.register(employeesRoutes);

// ── Start Server ─────────────────────────────────────
try {
  const address = await app.listen({
    port: env.PORT ?? env.API_PORT,
    host: env.API_HOST,
  });
  app.log.info(`🚀 API server running at ${address}`);
  app.log.info(`   Health: ${address}/api/v1/health`);
  // app.log.info(`   DB Status: ${address}/api/v1/system/db-status`); // uncomment when dual-db is active
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// // ▼▼▼ DUAL-DB Shutdown (Commented) ▼▼▼
// const closeApp = async () => {
//   app.log.info("Shutting down API…");
//   await app.close();
//   if (dbManager) await dbManager.stop();
//   process.exit(0);
// };
// process.once("SIGTERM", closeApp);
// process.once("SIGINT", closeApp);
// ▲▲▲ DUAL-DB Shutdown ▲▲▲

export default app;