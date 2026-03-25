import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import sensible from "@fastify/sensible";
import { env } from "./lib/env.js";

// Route modules
import { authRoutes } from "./routes/auth.js";
import { windowRoutes } from "./routes/window.js";
import { productRoutes } from "./routes/products.js";
import { orderRoutes } from "./routes/orders.js";
import { dealerRoutes } from "./routes/dealers.js";
import { inventoryRoutes } from "./routes/inventory.js";
import { distributionRoutes } from "./routes/distribution.js";

const app = Fastify({
  logger: {
    level: env.NODE_ENV === "production" ? "info" : "debug",
    transport:
      env.NODE_ENV === "development"
        ? { target: "pino-pretty", options: { colorize: true } }
        : undefined,
  },
});

// ── Plugins ──
await app.register(cors, {
  origin: env.NODE_ENV === "production"
    ? ["https://erp.haverimunion.coop"] // production domain
    : true, // allow all in development
  credentials: true,
});

await app.register(cookie, {
  secret: env.SESSION_SECRET,
});

await app.register(sensible);

// ── Global error handler (Zod validation errors) ──
app.setErrorHandler((error, request, reply) => {
  // Zod validation errors
  if (error.name === "ZodError") {
    return reply.status(400).send({
      error: "Validation Error",
      message: "Invalid request data",
      details: (error as any).issues,
    });
  }

  // Fastify validation errors
  if (error.validation) {
    return reply.status(400).send({
      error: "Validation Error",
      message: error.message,
    });
  }

  // Log unexpected errors
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
  version: "0.0.1",
}));

// ── Register Routes ──
await app.register(authRoutes);
await app.register(windowRoutes);
await app.register(productRoutes);
await app.register(orderRoutes);
await app.register(dealerRoutes);
await app.register(inventoryRoutes);
await app.register(distributionRoutes);

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
