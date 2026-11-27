// apps/api/src/lib/admin-notifications.ts
// ════════════════════════════════════════════════════════════════════
// Staff (admin web) notifications (0086). A notification is addressed to
// staff roles; super_admin sees every one. The web bell polls
// GET /api/v1/admin-notifications.
//
// Best-effort by design: callers wrap notifyStaff in try/catch (or use
// notifyStaffSafe) so a failed notification never fails the action that
// triggered it.
// ════════════════════════════════════════════════════════════════════
import type { FastifyBaseLogger } from "fastify";
import { pgClient } from "./db.js";

type Sql = typeof pgClient;

export interface StaffNotification {
  kind: "product_demand" | "officer_shortage";
  title: string;
  body?: string | null;
  link?: string | null;
  roles: string[];
  refId?: string | null;
}

/** Who hears about what. super_admin is implied for every kind. */
export const NOTIFY_ROLES = {
  // Dealer tapped "Notify" on an out-of-stock product: indent desk,
  // management and the FGS / dispatch people who can make or move stock.
  productDemand: ["manager", "call_desk", "dispatch_officer", "fgs_milk_curd", "fgs_others"],
  // Route officer recorded / changed a shortage against a contractor:
  // Marketing (prepares DTC bills) and Finance (audits and pays them).
  officerShortage: ["manager", "accountant"],
} as const;

export async function notifyStaff(sql: Sql, n: StaffNotification) {
  await sql`
    INSERT INTO admin_notifications (kind, title, body, link, roles, ref_id)
    VALUES (${n.kind}, ${n.title}, ${n.body ?? null}, ${n.link ?? null},
            string_to_array(${n.roles.join(",")}, ','), ${n.refId ?? null}::uuid)
  `;
}

/** notifyStaff on the shared client, logging instead of throwing. */
export async function notifyStaffSafe(log: FastifyBaseLogger, n: StaffNotification) {
  try {
    await notifyStaff(pgClient, n);
  } catch (err) {
    log.warn({ err, kind: n.kind }, "[admin-notifications] could not record notification");
  }
}
