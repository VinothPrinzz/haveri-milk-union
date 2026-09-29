import { sql } from "../lib/db.js";
import { enqueuePush } from "../lib/queues.js";

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/**
 * Today in IST.
 *
 * This job is scheduled at 05:00 AM IST, which is 23:30 UTC on the day
 * BEFORE — so `new Date().toISOString()` handed it yesterday's date every
 * single time it ran. It pre-generated the dispatch sheet for the wrong
 * day, and counted confirmed orders against the wrong delivery_date: 360
 * such rows were written between 2026-06-13 and 2026-07-22, all at 05:00
 * IST, all stamped a day behind. Anything scheduled before 05:30 IST must
 * add the offset.
 */
function istToday(): string {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

export async function processDispatchPregenerate() {
  const today = istToday();

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
      WHERE COALESCE(o.route_id, d.route_id) = ${route.id}
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

  // Queue window opening notification for all zones
  await enqueuePush("window-opening-reminder", {
    event: "window.opening" as const,
    title: "Window Opening Soon 🟢",
    body: "The ordering window opens in 5 minutes. Get ready to place your indent!",
  });

  return { date: today, status: "created", count: created };
}
