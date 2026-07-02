// apps/api/src/lib/dealer-route.ts
//
// A dealer can only place orders on a delivery route they're assigned to.
// The ordering window, dispatch sheet, and route-sheet all key off the
// dealer's route_id — a dealer with no route has no window and no place on
// any dispatch, so an order from them is undeliverable. This helper is the
// single source of truth for that gate, used by every order-creating
// endpoint (cart order, indent draft build, indent confirm).

import { pgClient } from "./db.js";

/**
 * Returns the dealer's assigned route_id, or null if they have none.
 * (route_id is nullable on `dealers`; a freshly-created dealer or one whose
 * route was removed has NULL here.)
 */
export async function getDealerRouteId(
  dealerId: string
): Promise<string | null> {
  const [row] = (await pgClient`
    SELECT route_id::text AS "routeId"
      FROM dealers
     WHERE id = ${dealerId}::uuid
     LIMIT 1
  `) as unknown as Array<{ routeId: string | null }>;
  return row?.routeId ?? null;
}

/**
 * Standard 403 payload for a dealer with no route. Keep the wording
 * identical everywhere so the dealer app shows one consistent message.
 */
export const NO_ROUTE_RESPONSE = {
  error: "No delivery route",
  message:
    "Your account isn't assigned to a delivery route yet, so orders can't be placed. Please contact the dairy office to get a route assigned.",
} as const;
