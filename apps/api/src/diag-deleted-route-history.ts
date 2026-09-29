// ═══════════════════════════════════════════════════════════════════════
// diag-deleted-route-history.ts — READ ONLY.
//
// Answers: when a route (or a dealer's route link) is removed, what happens
// to the sales already booked on it? Prints the route masters (live and
// soft-deleted), the sales sitting on each, and how many of those orders
// carry their own route snapshot vs. relying on the dealer's current route.
//
// USAGE (from apps/api):  npx tsx src/diag-deleted-route-history.ts [nameLike]
// ═══════════════════════════════════════════════════════════════════════

import { pgClient } from "./lib/db.js";

const like = `%${(process.argv[2] ?? "").toUpperCase()}%`;

async function main() {
  console.log("── Route masters (all, incl. soft-deleted) ──");
  const routes = await pgClient`
    SELECT r.id, r.code, r.name, r.active,
           to_char(r.deleted_at, 'YYYY-MM-DD HH24:MI') AS deleted_at,
           (SELECT count(*)::int FROM dealers d
             WHERE d.route_id = r.id AND d.deleted_at IS NULL) AS dealers_pointing,
           (SELECT count(*)::int FROM dealer_routes dr WHERE dr.route_id = r.id) AS dealer_links,
           (SELECT count(*)::int FROM orders o WHERE o.route_id = r.id) AS orders_snapshotted
    FROM routes r
    ORDER BY r.deleted_at NULLS FIRST, r.code
  `;
  for (const r of routes as any[]) {
    const flag = r.deleted_at ? `DELETED ${r.deleted_at}` : r.active ? "live" : "inactive";
    console.log(
      `  ${String(r.code).padEnd(22)} ${String(r.name).padEnd(28)} ${flag.padEnd(24)}` +
        ` dealers=${r.dealers_pointing} links=${r.dealer_links} orders(route_id)=${r.orders_snapshotted}`,
    );
  }

  console.log("\n── Dealers matching the search ──");
  const dealers = await pgClient`
    SELECT d.id, d.code, d.name, d.route_id,
           (SELECT r.name FROM routes r WHERE r.id = d.route_id) AS route_name,
           (SELECT count(*)::int FROM dealer_routes dr WHERE dr.dealer_id = d.id) AS links,
           to_char(d.deleted_at, 'YYYY-MM-DD') AS deleted_at
    FROM dealers d
    WHERE upper(d.name) LIKE ${like} OR upper(COALESCE(d.code, '')) LIKE ${like}
    ORDER BY d.name
    LIMIT 20
  `;
  for (const d of dealers as any[]) {
    console.log(
      `  ${String(d.code ?? "").padEnd(10)} ${String(d.name).padEnd(30)}` +
        ` route=${d.route_name ?? "(none)"} links=${d.links}${d.deleted_at ? " DELETED " + d.deleted_at : ""}`,
    );
  }

  console.log("\n── Orders with NO route snapshot (fall back to dealer's current route) ──");
  const orphans = await pgClient`
    SELECT to_char(o.delivery_date, 'YYYY-MM') AS month,
           count(*)::int AS orders,
           count(*) FILTER (WHERE o.route_id IS NULL)::int AS no_snapshot,
           count(*) FILTER (WHERE o.route_id IS NULL AND d.route_id IS NULL)::int AS no_route_at_all
    FROM orders o
    JOIN dealers d ON d.id = o.dealer_id
    WHERE o.status IN ('confirmed', 'dispatched', 'delivered')
      AND o.delivery_date >= (CURRENT_DATE - 90)
    GROUP BY 1 ORDER BY 1
  `;
  for (const r of orphans as any[]) {
    console.log(
      `  ${r.month}  orders=${String(r.orders).padStart(5)}  no route snapshot=${String(r.no_snapshot).padStart(5)}` +
        `  route unresolvable=${String(r.no_route_at_all).padStart(5)}`,
    );
  }

  console.log("\n── Confirmed sales sitting on a soft-deleted route (invisible today) ──");
  const hidden = await pgClient`
    SELECT r.code, r.name,
           to_char(o.delivery_date, 'YYYY-MM-DD') AS date,
           count(*)::int AS orders,
           SUM(o.grand_total)::numeric AS amount
    FROM orders o
    JOIN dealers d ON d.id = o.dealer_id
    JOIN routes r ON r.id = COALESCE(o.route_id, d.route_id)
    WHERE r.deleted_at IS NOT NULL
      AND o.status IN ('confirmed', 'dispatched', 'delivered')
    GROUP BY 1, 2, 3
    ORDER BY 3 DESC
    LIMIT 40
  `;
  if (hidden.length === 0) console.log("  (none)");
  for (const r of hidden as any[]) {
    console.log(
      `  ${r.date}  ${String(r.code).padEnd(22)} ${String(r.name).padEnd(28)}` +
        ` orders=${r.orders}  ₹${Number(r.amount).toLocaleString("en-IN")}`,
    );
  }

  await pgClient.end();
}

main().catch(async (e) => {
  console.error(e);
  await pgClient.end();
  process.exit(1);
});
