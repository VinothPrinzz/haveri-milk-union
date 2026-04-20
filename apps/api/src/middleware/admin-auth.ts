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

type UserRole = "super_admin" | "manager" | "dispatch_officer" | "accountant" | "call_desk" | "officer";

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

const ROLE_PERMISSIONS: Record<string, UserRole[]> = {
  // Dashboard — everyone
  dashboard: ["super_admin", "manager", "dispatch_officer", "accountant", "call_desk", "officer"],

  // Orders
  "orders.view":   ["super_admin", "manager", "call_desk", "officer"],
  "orders.create": ["super_admin", "call_desk", "officer"],
  "orders.update": ["super_admin", "manager"],
  "orders.cancel": ["super_admin", "manager"],

  // Products
  "products.view":   ["super_admin"],
  "products.manage": ["super_admin"],

  // Inventory / FGS
  "inventory.view":   ["super_admin", "dispatch_officer"],
  "inventory.update": ["super_admin", "dispatch_officer"],

  // Distribution / Routes
  "distribution.view":   ["super_admin", "manager", "dispatch_officer"],
  "distribution.manage": ["super_admin", "manager", "dispatch_officer"],

  // Dealers
  "dealers.view":   ["super_admin", "manager", "call_desk", "officer"],
  "dealers.manage": ["super_admin", "manager"],
  "dealers.wallet": ["super_admin", "call_desk"],

  // Finance
  "finance.view":   ["super_admin", "accountant"],
  "finance.manage": ["super_admin", "accountant"],

  // Reports
  "reports.view": ["super_admin", "manager", "dispatch_officer", "accountant"],

  // System
  "system.view":   ["super_admin"],
  "system.manage": ["super_admin"],
  "system.users":  ["super_admin"],

  // ── Phase 2 Permissions ──

  // Contractors (Masters → Contractors)
  "contractors.view":   ["super_admin", "manager", "dispatch_officer"],
  "contractors.manage": ["super_admin", "manager"],

  // Batches (Masters → Batches)
  "batches.view":   ["super_admin", "manager", "dispatch_officer"],
  "batches.manage": ["super_admin", "manager", "dispatch_officer"],

  // Direct Sales (Sales Operations → Gate Pass / Cash Customer)
  "direct_sales.view":   ["super_admin", "manager", "call_desk", "officer"],
  "direct_sales.manage": ["super_admin", "manager", "call_desk", "officer"],

  // Price Chart (Masters → Price Chart)
  "price_chart.view":   ["super_admin", "manager", "accountant", "officer"],
  "price_chart.manage": ["super_admin", "manager"],

  // Route Sheets (Reports → Route Sheet)
  "route_sheets.view":   ["super_admin", "manager", "dispatch_officer"],
  "route_sheets.manage": ["super_admin", "manager", "dispatch_officer"],

  // Sales Reports (9 report types)
  "sales_reports.view": ["super_admin", "manager", "accountant"],

  // Cash Customers (used by Direct Sales)
  "cash_customers.view":   ["super_admin", "manager", "call_desk", "officer"],
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

    if (!allowedRoles.includes(request.admin.role)) {
      return reply.status(403).send({
        error: "Forbidden",
        message: `Role '${request.admin.role}' does not have '${permission}' access`,
      });
    }
  };
}
