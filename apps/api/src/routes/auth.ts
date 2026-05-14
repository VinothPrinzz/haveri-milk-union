import type { FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { z } from "zod";
import { eq, and, sql, gt, desc, isNull } from "drizzle-orm";
import { db, pgClient } from "../lib/db.js";
import {
  dealers,
  dealerWallets,
  dealerOtps,
  dealerRefreshTokens,
  users,
  adminSessions,
} from "@hmu/db/schema";
import {
  signDealerAccessToken,
  signDealerRefreshToken,
  verifyDealerRefreshToken,
  comparePassword,
  hashPassword,
  generateSessionToken,
  generateOTP,
} from "../lib/auth.js";
import { env } from "../lib/env.js";
import { nanoid } from "nanoid";

export async function authRoutes(app: FastifyInstance) {
  // ─────────────────────────────────────────────────────────────
  // DEALER LOGIN — Username + Password (NEW)
  // ─────────────────────────────────────────────────────────────
  app.post("/api/v1/auth/dealer/login", async (request, reply) => {
    const schema = z.object({
      username: z.string().min(1),   // can be phone or custom username
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
      .where(
        and(
          eq(dealers.username, username),
          isNull(dealers.deletedAt)
        )
      )
      .limit(1);

    if (!dealer || !dealer.active || dealer.deletedAt) {
      return reply.status(401).send({
        error: "Unauthorized",
        message: "Invalid username or password",
      });
    }

    const passwordMatch = await comparePassword(password, dealer.passwordHash || "");
    if (!passwordMatch) {
      return reply.status(401).send({
        error: "Unauthorized",
        message: "Invalid username or password",
      });
    }

    // Generate tokens
    const payload = {
      dealerId: dealer.id,
      phone: dealer.phone,
      zoneId: dealer.zoneId,
    };

    const accessToken = signDealerAccessToken(payload);
    const refreshToken = signDealerRefreshToken({ ...payload, family: "dealer" });

    // Store refresh token
    await db.insert(dealerRefreshTokens).values({
      dealerId: dealer.id,
      token: refreshToken,
      family: "dealer",
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });

    return reply.send({
      accessToken,
      refreshToken,
      dealer: {
        id: dealer.id,
        phone: dealer.phone,
      },
    });
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
}
