import { Job, Queue } from "bullmq";
import { sql } from "../lib/db.js";
import { redis } from "../lib/redis.js";

export async function processDispatchPregenerate(job: Job) {
  const today = new Date().toISOString().split("T")[0];

  console.log(`[Dispatch] Pre-generating dispatch sheet for ${today}`);

  // Check if assignments already exist for today
  const [existing] = await sql`
    SELECT count(*)::int AS count FROM route_assignments WHERE date = ${today}::date
  `;

  if (existing && existing.count > 0) {
    console.log(`[Dispatch] ${existing.count} assignments already exist for ${today} — skipping`);
    return { date: today, status: "already_exists", count: existing.count };
  }

  // Get all active routes
  const routes = await sql`
    SELECT r.id, r.name, r.zone_id, z.name AS zone_name
    FROM routes r
    JOIN zones z ON z.id = r.zone_id
    WHERE r.active = true AND r.deleted_at IS NULL
    ORDER BY r.code
  `;

  if (routes.length === 0) {
    console.log("[Dispatch] No active routes found");
    return { date: today, status: "no_routes" };
  }

  let created = 0;

  for (const route of routes) {
    // Count pending/confirmed orders for this zone
    const [orderStats] = await sql`
      SELECT count(*)::int AS order_count,
             COALESCE(SUM(item_count), 0)::int AS total_items
      FROM orders
      WHERE zone_id = ${route.zone_id}
        AND created_at::date = ${today}::date
        AND status IN ('pending', 'confirmed')
    `;

    // Count active dealers in this zone
    const [dealerStats] = await sql`
      SELECT count(*)::int AS dealer_count
      FROM dealers
      WHERE zone_id = ${route.zone_id}
        AND active = true
        AND deleted_at IS NULL
    `;

    // Create assignment
    await sql`
      INSERT INTO route_assignments (route_id, date, dealer_count, item_count, status)
      VALUES (${route.id}, ${today}::date, ${dealerStats?.dealer_count ?? 0}, ${orderStats?.total_items ?? 0}, 'pending')
    `;

    created++;
  }

  console.log(`[Dispatch] ✅ Created ${created} route assignments for ${today}`);

  // Queue window opening notification for all zones
  const notifQueue = new Queue("push-notifications", { connection: redis });
  await notifQueue.add("window-opening-reminder", {
    event: "window.opening" as const,
    title: "Window Opening Soon 🟢",
    body: "The ordering window opens in 5 minutes. Get ready to place your indent!",
  });
  await notifQueue.close();

  return { date: today, status: "created", count: created };
}
