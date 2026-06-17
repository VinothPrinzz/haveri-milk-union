import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, and, ne, sql, gt, isNull } from "drizzle-orm";
import { db, pgClient } from "../lib/db.js";
import {
  dealers,
  dealerRefreshTokens,
  users,
  adminSessions,
} from "@hmu/db/schema";
import {
  signDealerAccessToken,
  signDealerRefreshToken,
  comparePassword,
  hashPassword,
  generateSessionToken,
  verifyDealerRefreshToken,
} from "../lib/auth.js";
import { adminAuth } from "../middleware/admin-auth.js";

export async function authRoutes(app: FastifyInstance) {
  // ─────────────────────────────────────────────────────────────
  // DEALER LOGIN — Username + Password (NEW)
  // ─────────────────────────────────────────────────────────────
  app.post("/api/v1/auth/dealer/login", async (request, reply) => {
    const schema = z.object({
      username: z.string().min(1), // can be phone or custom username
      password: z.string().min(1),
    });
   
    const { username, password } = schema.parse(request.body);
   
    const [dealer] = await db
      .select({
        id: dealers.id,
        phone: dealers.phone,
        zoneId: dealers.zoneId,
        passwordHash: dealers.passwordHash,
        active: dealers.active,
        deletedAt: dealers.deletedAt,
      })
      .from(dealers)
      .where(and(eq(dealers.username, username), isNull(dealers.deletedAt)))
      .limit(1);
   
    if (!dealer) {
      return reply
        .status(401)
        .send({ error: "Unauthorized", message: "Invalid username or password" });
    }
    if (!dealer.active) {
      return reply
        .status(401)
        .send({ error: "Unauthorized", message: "Account is inactive" });
    }
    if (dealer.deletedAt) {
      return reply
        .status(401)
        .send({ error: "Unauthorized", message: "Invalid username or password" });
    }
   
    const passwordMatch = await comparePassword(
      password,
      dealer.passwordHash || ""
    );
    if (!passwordMatch) {
      return reply
        .status(401)
        .send({ error: "Unauthorized", message: "Invalid username or password" });
    }
   
    // ── Issue tokens ──
    const payload = {
      dealerId: dealer.id,
      phone: dealer.phone,
      zoneId: dealer.zoneId,
    };
    const accessToken = signDealerAccessToken(payload);
    const refreshToken = signDealerRefreshToken({ ...payload, family: "dealer" });
   
    await db.insert(dealerRefreshTokens).values({
      dealerId: dealer.id,
      token: refreshToken,
      family: "dealer",
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });
   
    // ── FIX: return the FULL dealer profile, not just { id, phone } ──
    // Same query as GET /api/v1/dealer/profile, but with LEFT JOIN zones
    // so a dealer whose zone_id is still NULL can log in (the inner JOIN
    // version 404s such dealers).
    const [profile] = await pgClient`
      SELECT d.*,
             z.name AS zone_name,
             r.name AS route_name,
             r.code AS route_code,
             COALESCE(w.balance, 0) AS wallet_balance,
             COALESCE((
               SELECT SUM(o.grand_total) FROM orders o
                WHERE o.dealer_id = d.id
                  AND o.payment_mode = 'credit'
                  AND o.status NOT IN ('cancelled', 'delivered')
             ), 0) AS credit_outstanding
        FROM dealers d
        LEFT JOIN zones z          ON z.id = d.zone_id
        LEFT JOIN routes r         ON r.id = d.route_id
        LEFT JOIN dealer_wallets w ON w.dealer_id = d.id
       WHERE d.id = ${dealer.id} AND d.deleted_at IS NULL
       LIMIT 1
    `;
   
    return reply.send({
      accessToken,
      refreshToken,
      // profile should always exist here (we just authenticated this row),
      // but fall back defensively.
      dealer: profile ?? { id: dealer.id, phone: dealer.phone },
    });
  });

  // POST /api/v1/auth/dealer/refresh
  app.post("/api/v1/auth/dealer/refresh", async (request, reply) => {
    const { refreshToken } = z
      .object({ refreshToken: z.string().min(1) })
      .parse(request.body);

    let payload: ReturnType<typeof verifyDealerRefreshToken>;
    try {
      payload = verifyDealerRefreshToken(refreshToken);
    } catch {
      return reply.status(401).send({ error: "Unauthorized", message: "Invalid or expired refresh token" });
    }

    // Check it exists and isn't revoked
    const [row] = await db
      .select()
      .from(dealerRefreshTokens)
      .where(
        and(
          eq(dealerRefreshTokens.token, refreshToken),
          isNull(dealerRefreshTokens.revokedAt),
          gt(dealerRefreshTokens.expiresAt, new Date())
        )
      )
      .limit(1);

    if (!row) {
      return reply.status(401).send({ error: "Unauthorized", message: "Refresh token revoked or not found" });
    }

    // Rotate — revoke old, issue new
    const tokenPayload = {
      dealerId: payload.dealerId,
      phone: payload.phone,
      zoneId: payload.zoneId,
    };

    const newAccessToken = signDealerAccessToken(tokenPayload);
    const newRefreshToken = signDealerRefreshToken({ ...tokenPayload, family: row.family });

    await db
      .update(dealerRefreshTokens)
      .set({ revokedAt: new Date() })
      .where(eq(dealerRefreshTokens.id, row.id));

    await db.insert(dealerRefreshTokens).values({
      dealerId: payload.dealerId,
      token: newRefreshToken,
      family: row.family,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });

    return reply.send({ accessToken: newAccessToken, refreshToken: newRefreshToken });
  });

  // ════════════════════════════════════════════
  // ADMIN AUTH — Email + Password, server-side sessions
  // ════════════════════════════════════════════

  // POST /api/v1/auth/admin/login
  app.post("/api/v1/auth/admin/login", async (request, reply) => {
    const schema = z.object({
      username: z.string().min(1),   // ← was: email: z.string().email()
      password: z.string().min(1),
    });
    const body = schema.parse(request.body);
   
    // Look up by username (case-insensitive for convenience)
    const [user] = await db
      .select()
      .from(users)
      .where(
        and(
          eq(sql`LOWER(${users.username})`, body.username.toLowerCase()),
          isNull(users.deletedAt),
        ),
      )
      .limit(1);
   
    if (!user || !user.active) {
      return reply.status(401).send({
        error: "Unauthorized",
        message: "Invalid username or password",
      });
    }
   
    // Verify password
    const valid = await comparePassword(body.password, user.passwordHash);
    if (!valid) {
      return reply.status(401).send({
        error: "Unauthorized",
        message: "Invalid username or password",
      });
    }
   
    // Create session
    const token = generateSessionToken();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
   
    await db.insert(adminSessions).values({
      userId:    user.id,
      token,
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"] ?? null,
      expiresAt,
    });
   
    // Update last login timestamp
    await db
      .update(users)
      .set({ lastLoginAt: new Date() })
      .where(eq(users.id, user.id));
   
    // Set httpOnly cookie
    reply.setCookie("hmu_session", token, {
      httpOnly: true,
      secure:   true,
      sameSite: "none",
      path:     "/",
      maxAge:   24 * 60 * 60,
    });
   
    return reply.status(200).send({
      message: "Login successful",
      user: {
        id:       user.id,
        name:     user.name,
        username: user.username,   // ← added
        email:    user.email,
        role:     user.role,
        zoneId:   user.zoneId,
      },
      sessionToken: token,
    });
  });  

  // POST /api/v1/auth/admin/logout
  app.post("/api/v1/auth/admin/logout", async (request, reply) => {
    const sessionToken =
      request.cookies?.["hmu_session"] ||
      (request.headers["x-session-token"] as string | undefined);

    if (sessionToken) {
      // Delete the session from DB
      await db
        .delete(adminSessions)
        .where(eq(adminSessions.token, sessionToken));
    }

    // Clear cookie
    reply.clearCookie("hmu_session", { path: "/" });

    return reply.status(200).send({ message: "Logged out successfully" });
  });

  // GET /api/v1/auth/admin/me — returns current admin user from session
  app.get("/api/v1/auth/admin/me", async (request, reply) => {
    const sessionToken =
      request.cookies?.["hmu_session"] ||
      (request.headers["x-session-token"] as string | undefined);

    if (!sessionToken) {
      return reply.status(401).send({ error: "Unauthorized" });
    }

    const [session] = await db
      .select({ userId: adminSessions.userId })
      .from(adminSessions)
      .where(
        and(
          eq(adminSessions.token, sessionToken),
          gt(adminSessions.expiresAt, new Date()),
        ),
      )
      .limit(1);

    if (!session) {
      return reply.status(401).send({ error: "Unauthorized" });
    }

    const [user] = await db
      .select({
        id: users.id,
        name: users.name,
        username: users.username,
        email: users.email,
        role: users.role,
        zoneId: users.zoneId,
      })
      .from(users)
      .where(and(eq(users.id, session.userId), isNull(users.deletedAt)))
      .limit(1);

    if (!user) {
      return reply.status(401).send({ error: "Unauthorized" });
    }

    return reply.status(200).send({ user });
  });

  // POST /api/v1/auth/admin/change-password
  // Self-service: the logged-in admin changes their OWN password after
  // verifying their current one. Distinct from PATCH /users/:id/reset-password
  // (which is a super-admin resetting someone else's password, no current-
  // password check). Any authenticated admin role may use this.
  app.post(
    "/api/v1/auth/admin/change-password",
    { preHandler: [adminAuth] },
    async (request, reply) => {
      const schema = z.object({
        currentPassword: z.string().min(1),
        newPassword: z.string().min(6, "New password must be at least 6 characters"),
      });
      const { currentPassword, newPassword } = schema.parse(request.body);
      const userId = request.admin!.userId;

      const [user] = await db
        .select({ id: users.id, passwordHash: users.passwordHash })
        .from(users)
        .where(and(eq(users.id, userId), isNull(users.deletedAt)))
        .limit(1);

      if (!user) {
        return reply.status(401).send({ error: "Unauthorized" });
      }

      // Verify current password
      const valid = await comparePassword(currentPassword, user.passwordHash);
      if (!valid) {
        return reply.status(400).send({
          error: "Bad Request",
          message: "Current password is incorrect",
        });
      }

      // Disallow reusing the same password
      const same = await comparePassword(newPassword, user.passwordHash);
      if (same) {
        return reply.status(400).send({
          error: "Bad Request",
          message: "New password must be different from your current password",
        });
      }

      const newHash = await hashPassword(newPassword);
      await db
        .update(users)
        .set({ passwordHash: newHash, updatedAt: new Date() })
        .where(eq(users.id, userId));

      // Security: revoke this user's OTHER sessions, keep the current one alive.
      const currentToken =
        request.cookies?.["hmu_session"] ||
        (request.headers["x-session-token"] as string | undefined);
      if (currentToken) {
        await db
          .delete(adminSessions)
          .where(
            and(
              eq(adminSessions.userId, userId),
              ne(adminSessions.token, currentToken),
            ),
          );
      }

      return reply.status(200).send({ message: "Password changed successfully" });
    },
  );
}
