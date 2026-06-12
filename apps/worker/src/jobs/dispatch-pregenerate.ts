import { Job } from "bullmq";
import { sql } from "../lib/db.js";
import { pushQueue as notifQueue } from "../lib/queues.js";

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
    SELECT r.id, r.code, r.name
    FROM routes r
    WHERE r.active = true AND r.deleted_at IS NULL
    ORDER BY r.code
  `;

  if (routes.length === 0) {
    console.log("[Dispatch] No active routes found");
    return { date: today, status: "no_routes" };
  }

  let created = 0;

  for (const route of routes) {
    // Count confirmed orders for this route
    const [orderStats] = await sql`
      SELECT count(*)::int AS order_count,
             COALESCE(SUM(item_count), 0)::int AS total_items
      FROM orders o
      JOIN dealers d ON d.id = o.dealer_id
      WHERE d.route_id = ${route.id}
        AND o.delivery_date = ${today}::date
        AND o.status = 'confirmed'
    `;

    // Count active dealers in this zone
    const [dealerStats] = await sql`
      SELECT count(*)::int AS dealer_count
      FROM dealers
      WHERE route_id = ${route.id}
        AND active = true
        AND deleted_at IS NULL
    `;

    // Create assignment
    await sql`
      INSERT INTO route_assignments (route_id, date, dealer_count, item_count, status)
      VALUES (${route.id}, ${today}::date,
              ${dealerStats?.dealer_count ?? 0},
              ${orderStats?.total_items ?? 0},
              'pending')
    `;

    created++;
  }

  console.log(`[Dispatch] ✅ Created ${created} route assignments for ${today}`);

  // Queue window opening notification for all zones (shared queue — not closed here)
  await notifQueue.add("window-opening-reminder", {
    event: "window.opening" as const,
    title: "Window Opening Soon 🟢",
    body: "The ordering window opens in 5 minutes. Get ready to place your indent!",
  });

  return { date: today, status: "created", count: created };
}
