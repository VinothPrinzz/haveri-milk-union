import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "../lib/db.js";
import { zones, timeWindows, routes } from "@hmu/db/schema";

// ── Shared helper ─────────────────────────────────────────────────────────
function computeWindowState(
  tw: { openTime: string; closeTime: string; warningMinutes: number; active: boolean }
): { state: "open" | "warning" | "closed"; remainingSeconds: number } {
  const now = new Date();
  const istTime = new Date(
    now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" })
  );
  const currentMinutes = istTime.getHours() * 60 + istTime.getMinutes();

  const [openH, openM] = tw.openTime.split(":").map(Number);
  const [closeH, closeM] = tw.closeTime.split(":").map(Number);
  const openMinutes = openH! * 60 + openM!;
  const closeMinutes = closeH! * 60 + closeM!;
  const warningMinutes = closeMinutes - tw.warningMinutes;

  let state: "open" | "warning" | "closed";
  let remainingSeconds = 0;

  if (!tw.active) {
    state = "closed";
  } else if (currentMinutes < openMinutes) {
    state = "closed";
  } else if (currentMinutes >= closeMinutes) {
    state = "closed";
  } else if (currentMinutes >= warningMinutes) {
    state = "warning";
    remainingSeconds = (closeMinutes - currentMinutes) * 60;
  } else {
    state = "open";
    remainingSeconds = (closeMinutes - currentMinutes) * 60;
  }

  return { state, remainingSeconds };
}

export async function windowRoutes(app: FastifyInstance) {
  // ── Route-based window status (new primary path) ────────────────────────
  //
  // GET /api/v1/window/status/:routeId
  // Called by the dealer app on load and polled every 30 seconds.
  app.get("/api/v1/window/status/route/:routeId", async (request, reply) => {
    const { routeId } = request.params as { routeId: string };

    const [tw] = await db
      .select({
        routeId:        timeWindows.routeId,
        routeName:      routes.name,
        routeCode:      routes.code,
        openTime:       timeWindows.openTime,
        warningMinutes: timeWindows.warningMinutes,
        closeTime:      timeWindows.closeTime,
        active:         timeWindows.active,
      })
      .from(timeWindows)
      .innerJoin(routes, eq(routes.id, timeWindows.routeId))
      .where(eq(timeWindows.routeId, routeId))
      .limit(1);

    if (!tw) {
      return reply.status(404).send({
        error: "Not Found",
        message: "Time window not configured for this route",
      });
    }

    const now = new Date();
    const { state, remainingSeconds } = computeWindowState(tw);

    return reply.status(200).send({
      routeId: tw.routeId,
      routeName: tw.routeName,
      routeCode: tw.routeCode,
      state,
      openTime: tw.openTime,
      closeTime: tw.closeTime,
      warningMinutes: tw.warningMinutes,
      remainingSeconds,
      serverTime: now.toISOString(),
    });
  });

  // GET /api/v1/window/status — all routes (route-based)
  app.get("/api/v1/window/status/routes", async (request, reply) => {
    const allWindows = await db
      .select({
        routeId:        timeWindows.routeId,
        routeName:      routes.name,
        routeCode:      routes.code,
        openTime:       timeWindows.openTime,
        warningMinutes: timeWindows.warningMinutes,
        closeTime:      timeWindows.closeTime,
        active:         timeWindows.active,
      })
      .from(timeWindows)
      .innerJoin(routes, eq(routes.id, timeWindows.routeId));

    const now = new Date();
    const results = allWindows.map((tw) => {
      const { state } = computeWindowState(tw);
      return { ...tw, state };
    });

    return reply.status(200).send({ windows: results, serverTime: now.toISOString() });
  });

  // ── Zone-based window status (legacy — kept for backward compat) ────────
  //
  // GET /api/v1/window/status/:zoneId
  app.get("/api/v1/window/status/:zoneId", async (request, reply) => {
    const { zoneId } = request.params as { zoneId: string };

    const [tw] = await db
      .select({
        zoneId: timeWindows.zoneId,
        zoneName: zones.name,
        openTime: timeWindows.openTime,
        warningMinutes: timeWindows.warningMinutes,
        closeTime: timeWindows.closeTime,
        active: timeWindows.active,
      })
      .from(timeWindows)
      .innerJoin(zones, eq(zones.id, timeWindows.zoneId!))
      .where(eq(timeWindows.zoneId, zoneId))
      .limit(1);

    if (!tw) {
      return reply.status(404).send({
        error: "Not Found",
        message: "Time window not configured for this zone",
      });
    }

    const now = new Date();
    const { state, remainingSeconds } = computeWindowState(tw);

    return reply.status(200).send({
      zoneId: tw.zoneId,
      zoneName: tw.zoneName,
      state,
      openTime: tw.openTime,
      closeTime: tw.closeTime,
      warningMinutes: tw.warningMinutes,
      remainingSeconds,
      serverTime: now.toISOString(),
    });
  });

  // GET /api/v1/window/status — all zones (legacy)
  app.get("/api/v1/window/status", async (request, reply) => {
    const allWindows = await db
      .select({
        zoneId: timeWindows.zoneId,
        zoneName: zones.name,
        zoneSlug: zones.slug,
        openTime: timeWindows.openTime,
        warningMinutes: timeWindows.warningMinutes,
        closeTime: timeWindows.closeTime,
        active: timeWindows.active,
      })
      .from(timeWindows)
      .innerJoin(zones, eq(zones.id, timeWindows.zoneId!));

    const now = new Date();
    const results = allWindows.map((tw) => {
      const { state } = computeWindowState(tw);
      return { ...tw, state };
    });

    return reply.status(200).send({ windows: results, serverTime: now.toISOString() });
  });
}
