import type { FastifyRequest, FastifyReply } from "fastify";
import { eq, and, gt } from "drizzle-orm";
import { db } from "../lib/db.js";
import { adminSessions, users } from "@hmu/db/schema";

/**
 * Admin auth middleware — validates session token from httpOnly cookie.
 * Sets request.admin with user details and role.
 *
 * Usage in route: { preHandler: [adminAuth] }
 */

type UserRole = "super_admin" | "manager" | "dispatch_officer" | "accountant" | "call_desk" | "officer" | "viewer" | "fgs_milk_curd" | "fgs_others";

declare module "fastify" {
  interface FastifyRequest {
    admin?: {
      userId: string;
      name: string;
      email: string;
      role: UserRole;
      zoneId: string | null;
    };
  }
}

export async function adminAuth(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  // Session token from cookie or Authorization header (for API testing)
  const sessionToken =
    request.cookies?.["hmu_session"] ||
    request.headers["x-session-token"] as string | undefined;

  if (!sessionToken) {
    return reply.status(401).send({
      error: "Unauthorized",
      message: "No session token provided",
    });
  }

  try {
    // Look up session — must not be expired
    const [session] = await db
      .select({
        userId: adminSessions.userId,
        expiresAt: adminSessions.expiresAt,
      })
      .from(adminSessions)
      .where(
        and(
          eq(adminSessions.token, sessionToken),
          gt(adminSessions.expiresAt, new Date())
        )
      )
      .limit(1);

    if (!session) {
      return reply.status(401).send({
        error: "Unauthorized",
        message: "Invalid or expired session",
      });
    }

    // Fetch user details — must be active and not soft-deleted
    const [user] = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        role: users.role,
        zoneId: users.zoneId,
        active: users.active,
        deletedAt: users.deletedAt,
      })
      .from(users)
      .where(eq(users.id, session.userId))
      .limit(1);

    if (!user || !user.active || user.deletedAt) {
      return reply.status(401).send({
        error: "Unauthorized",
        message: "Account is inactive or deleted",
      });
    }

    request.admin = {
      userId: user.id,
      name: user.name,
      email: user.email,
      role: user.role as UserRole,
      zoneId: user.zoneId,
    };
  } catch (err) {
    request.log.error(err, "Admin auth middleware error");
    return reply.status(500).send({
      error: "Internal Server Error",
      message: "Authentication check failed",
    });
  }
}

// ── Role-Based Access Control ──
// Permission map: which roles can access which modules.
// A mistake here could let a Call Desk user access finance data.

// Super-user roles: allowed on EVERY defined permission below, so they never
// need to be listed individually. `super_admin` is the built-in admin;
// `call_desk` (Indent Operators) is granted full parity per ops requirement —
// they run the whole desk and need every module. Note this deliberately does
// NOT cover the database failover / reconciliation endpoints, which check
// `role === "super_admin"` directly (see db-status.ts / db-reconciliation.ts).
const SUPER_ROLES: UserRole[] = ["super_admin", "call_desk"];

// NOTE on the `viewer` role: it is a read-only role. It is added to EVERY
// "*.view" / read-style permission below and to NONE of the "*.manage" /
// create / update / cancel / wallet / users permissions. Result: a viewer can
// browse every module but every write endpoint returns 403. When adding a new
// permission, remember to include "viewer" only if it is a pure read.
const ROLE_PERMISSIONS: Record<string, UserRole[]> = {
  // Dashboard — everyone
  dashboard: ["super_admin", "manager", "dispatch_officer", "accountant", "call_desk", "officer", "viewer", "fgs_milk_curd", "fgs_others"],

  // Orders
  "orders.view":   ["super_admin", "manager", "call_desk", "officer", "viewer"],
  "orders.create": ["super_admin", "call_desk", "officer"],
  "orders.update": ["super_admin", "manager"],
  "orders.cancel": ["super_admin", "manager"],

  // Indents (admin standing-indent + daily-draft management).
  // Decoupled from dealers.* so Indent staff (call_desk) can record/edit
  // indents WITHOUT gaining dealer master-data (incl. credit) write access.
  "indents.view":   ["super_admin", "manager", "call_desk", "viewer"],
  "indents.manage": ["super_admin", "manager", "call_desk"],

  // Products
  "products.view":   ["super_admin", "viewer"],
  "products.manage": ["super_admin"],

  // Inventory / FGS. The bucket-scoped FGS roles share these permissions; the
  // inventory routes further restrict them to a single product bucket — see
  // bucketsForRole() in apps/api/src/routes/inventory.ts.
  "inventory.view":   ["super_admin", "dispatch_officer", "viewer", "fgs_milk_curd", "fgs_others"],
  "inventory.update": ["super_admin", "dispatch_officer", "fgs_milk_curd", "fgs_others"],

  // Route master list (GET /routes) — a plain lookup used by filter dropdowns
  // across modules, so it is split out from distribution.view. Finance needs it
  // for the route filter on AR Aging / Available Balances / Employee Credit /
  // Day Book, but has no business reading dispatch runs or vehicles.
  "routes.view": ["super_admin", "manager", "dispatch_officer", "accountant", "officer", "viewer", "fgs_milk_curd", "fgs_others"],

  // Distribution / Dispatch (incl. Dispatch Sheet) — officers run dispatch sheets
  "distribution.view":   ["super_admin", "manager", "dispatch_officer", "officer", "viewer", "fgs_milk_curd", "fgs_others"],
  "distribution.manage": ["super_admin", "manager", "dispatch_officer", "officer", "fgs_milk_curd", "fgs_others"],

  // Dealers. Finance (accountant) reads dealer master data throughout its own
  // module — the dealer picker on Payments / Online Payments / Adjustments /
  // Dealer Statements, and the `/dealers/:id/ledger` endpoints behind the
  // Dealer Ledger page. Read only; dealers.manage / dealers.wallet stay denied.
  "dealers.view":   ["super_admin", "manager", "accountant", "call_desk", "officer", "viewer"],
  "dealers.manage": ["super_admin", "manager"],
  "dealers.wallet": ["super_admin", "call_desk"],

  // Finance
  "finance.view":   ["super_admin", "accountant", "viewer"],
  "finance.manage": ["super_admin", "accountant"],

  // Reports (Route Sheet + Gate Pass report pages). Route officers are scoped
  // to reports-only in the admin UI, so they need read access here.
  "reports.view": ["super_admin", "manager", "dispatch_officer", "accountant", "officer", "viewer", "fgs_milk_curd", "fgs_others"],

  // System — viewer gets read-only system.view, but NOT system.users
  // (that permission also gates create/edit of users) or system.manage.
  "system.view":   ["super_admin", "viewer"],
  "system.manage": ["super_admin"],
  "system.users":  ["super_admin"],

  // ── Phase 2 Permissions ──

  // Contractors (Masters → Contractors)
  "contractors.view":   ["super_admin", "manager", "dispatch_officer", "viewer", "fgs_milk_curd", "fgs_others"],
  "contractors.manage": ["super_admin", "manager"],

  // Suppliers (Masters → Suppliers) — stock vendors. FGS/dispatch roles need
  // view so they can pick a supplier when recording received stock; only
  // masters staff manage the list.
  "suppliers.view":   ["super_admin", "manager", "dispatch_officer", "viewer", "fgs_milk_curd", "fgs_others"],
  "suppliers.manage": ["super_admin", "manager"],

  // Batches (Masters → Batches) — officers need read access for the batch
  // filter dropdown on the Route Sheet report page.
  "batches.view":   ["super_admin", "manager", "dispatch_officer", "officer", "viewer", "fgs_milk_curd", "fgs_others"],
  "batches.manage": ["super_admin", "manager", "dispatch_officer", "fgs_milk_curd", "fgs_others"],

  // Direct Sales (Sales Operations → Gate Pass / Cash Customer)
  "direct_sales.view":   ["super_admin", "manager", "call_desk", "officer", "viewer"],
  "direct_sales.manage": ["super_admin", "manager", "call_desk", "officer"],

  // VIP Contacts
  "vip_contacts.view":   ["super_admin", "manager", "call_desk", "officer", "viewer"],
  "vip_contacts.manage": ["super_admin", "manager"],

  // Employees (HR-ish master)
  "employees.view":   ["super_admin", "manager", "call_desk", "officer", "accountant", "viewer"],
  "employees.manage": ["super_admin", "manager"],

  // Officers (Masters → Officers) — field sales officers ↔ talukas
  "officers.view":   ["super_admin", "manager", "call_desk", "officer", "accountant", "viewer"],
  "officers.manage": ["super_admin", "manager"],

  // Price Chart (Masters → Price Chart)
  "price_chart.view":   ["super_admin", "manager", "accountant", "officer", "viewer"],
  "price_chart.manage": ["super_admin", "manager"],

  // Route Sheets (Reports → Route Sheet) — officers build/confirm route sheets
  "route_sheets.view":   ["super_admin", "manager", "dispatch_officer", "officer", "viewer", "fgs_milk_curd", "fgs_others"],
  "route_sheets.manage": ["super_admin", "manager", "dispatch_officer", "officer", "fgs_milk_curd", "fgs_others"],

  // Sales Reports (9 report types) — route officers are limited to Route Sheets
  // + Sales Reports in the admin UI, so they get read access here too.
  "sales_reports.view": ["super_admin", "manager", "accountant", "officer", "viewer"],

  // Cash Customers (used by Direct Sales)
  "cash_customers.view":   ["super_admin", "manager", "call_desk", "officer", "viewer"],
  "cash_customers.manage": ["super_admin", "manager", "call_desk", "officer"],
};

/**
 * Role guard factory — creates a preHandler that checks if the admin
 * has the required permission.
 *
 * Usage: { preHandler: [adminAuth, requireRole("orders.view")] }
 */
export function requireRole(permission: string) {
  return async function roleGuard(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    if (!request.admin) {
      return reply.status(401).send({
        error: "Unauthorized",
        message: "Not authenticated",
      });
    }

    const allowedRoles = ROLE_PERMISSIONS[permission];
    if (!allowedRoles) {
      request.log.warn(`Unknown permission: ${permission}`);
      return reply.status(403).send({
        error: "Forbidden",
        message: "Access denied",
      });
    }

    // Super-user roles clear every defined permission (mirrors super_admin
    // being listed in each array). Checked after the unknown-permission guard
    // so behaviour matches super_admin exactly.
    if (SUPER_ROLES.includes(request.admin.role)) return;

    if (!allowedRoles.includes(request.admin.role)) {
      return reply.status(403).send({
        error: "Forbidden",
        message: `Role '${request.admin.role}' does not have '${permission}' access`,
      });
    }
  };
}
