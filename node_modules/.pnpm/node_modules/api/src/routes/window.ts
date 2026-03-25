import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "../lib/db.js";
import { zones, timeWindows } from "@hmu/db/schema";

export async function windowRoutes(app: FastifyInstance) {
  // GET /api/v1/window/status/:zoneId
  // Returns window state (open/warning/closed) with times.
  // Called by dealer app on load and polled every 30 seconds.
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
      .innerJoin(zones, eq(zones.id, timeWindows.zoneId))
      .where(eq(timeWindows.zoneId, zoneId))
      .limit(1);

    if (!tw) {
      return reply.status(404).send({
        error: "Not Found",
        message: "Time window not configured for this zone",
      });
    }

    // Compute current window state using IST (Asia/Kolkata)
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

  // GET /api/v1/window/status — all zones
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
      .innerJoin(zones, eq(zones.id, timeWindows.zoneId));

    const now = new Date();
    const istTime = new Date(
      now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" })
    );
    const currentMinutes = istTime.getHours() * 60 + istTime.getMinutes();

    const results = allWindows.map((tw) => {
      const [openH, openM] = tw.openTime.split(":").map(Number);
      const [closeH, closeM] = tw.closeTime.split(":").map(Number);
      const openMins = openH! * 60 + openM!;
      const closeMins = closeH! * 60 + closeM!;
      const warnMins = closeMins - tw.warningMinutes;

      let state: "open" | "warning" | "closed" = "closed";
      if (tw.active && currentMinutes >= openMins && currentMinutes < closeMins) {
        state = currentMinutes >= warnMins ? "warning" : "open";
      }

      return { ...tw, state };
    });

    return reply.status(200).send({ windows: results, serverTime: now.toISOString() });
  });
}
