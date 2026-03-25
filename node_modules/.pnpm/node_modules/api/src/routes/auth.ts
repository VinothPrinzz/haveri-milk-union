import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, and, gt, desc, isNull } from "drizzle-orm";
import { db } from "../lib/db.js";
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
  // ════════════════════════════════════════════
  // DEALER AUTH — OTP-based
  // ════════════════════════════════════════════

  // POST /api/v1/auth/dealer/request-otp
  // Sends an OTP to the dealer's phone. In dev, returns it directly.
  app.post("/api/v1/auth/dealer/request-otp", async (request, reply) => {
    const schema = z.object({ phone: z.string().min(10).max(15) });
    const body = schema.parse(request.body);

    // Check dealer exists and is active
    const [dealer] = await db
      .select({ id: dealers.id, name: dealers.name, active: dealers.active, deletedAt: dealers.deletedAt })
      .from(dealers)
      .where(eq(dealers.phone, body.phone))
      .limit(1);

    if (!dealer || !dealer.active || dealer.deletedAt) {
      return reply.status(404).send({
        error: "Not Found",
        message: "No active dealer found with this phone number",
      });
    }

    // Generate OTP
    const otp = generateOTP();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

    await db.insert(dealerOtps).values({
      phone: body.phone,
      otp, // In production: hash this
      expiresAt,
    });

    // In development, return the OTP directly (no SMS integration yet)
    const response: Record<string, unknown> = {
      message: "OTP sent successfully",
      expiresIn: 300,
    };

    if (env.NODE_ENV === "development") {
      response.otp = otp; // Only in dev!
    }

    return reply.status(200).send(response);
  });

  // POST /api/v1/auth/dealer/verify-otp
  // Verifies OTP and returns access + refresh tokens.
  app.post("/api/v1/auth/dealer/verify-otp", async (request, reply) => {
    const schema = z.object({
      phone: z.string().min(10).max(15),
      otp: z.string().length(6),
    });
    const body = schema.parse(request.body);

    // Find the most recent unexpired, unverified OTP for this phone
    const [otpRecord] = await db
      .select()
      .from(dealerOtps)
      .where(
        and(
          eq(dealerOtps.phone, body.phone),
          eq(dealerOtps.verified, false),
          gt(dealerOtps.expiresAt, new Date())
        )
      )
      .orderBy(desc(dealerOtps.createdAt))
      .limit(1);

    if (!otpRecord || otpRecord.otp !== body.otp) {
      return reply.status(401).send({
        error: "Unauthorized",
        message: "Invalid or expired OTP",
      });
    }

    // Mark OTP as verified
    await db
      .update(dealerOtps)
      .set({ verified: true })
      .where(eq(dealerOtps.id, otpRecord.id));

    // Get dealer details
    const [dealer] = await db
      .select({
        id: dealers.id,
        name: dealers.name,
        phone: dealers.phone,
        zoneId: dealers.zoneId,
      })
      .from(dealers)
      .where(and(eq(dealers.phone, body.phone), isNull(dealers.deletedAt)))
      .limit(1);

    if (!dealer) {
      return reply.status(404).send({
        error: "Not Found",
        message: "Dealer not found",
      });
    }

    // Generate token family for refresh token rotation
    const family = nanoid(32);

    const tokenPayload = {
      dealerId: dealer.id,
      phone: dealer.phone,
      zoneId: dealer.zoneId,
    };

    const accessToken = signDealerAccessToken(tokenPayload);
    const refreshToken = signDealerRefreshToken({ ...tokenPayload, family });

    // Store refresh token
    await db.insert(dealerRefreshTokens).values({
      dealerId: dealer.id,
      token: refreshToken,
      family,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
    });

    return reply.status(200).send({
      accessToken,
      refreshToken,
      dealer: {
        id: dealer.id,
        name: dealer.name,
        phone: dealer.phone,
        zoneId: dealer.zoneId,
      },
    });
  });

  // POST /api/v1/auth/dealer/refresh
  // Rotates refresh token — issues new access + refresh tokens.
  app.post("/api/v1/auth/dealer/refresh", async (request, reply) => {
    const schema = z.object({ refreshToken: z.string().min(1) });
    const body = schema.parse(request.body);

    let payload;
    try {
      payload = verifyDealerRefreshToken(body.refreshToken);
    } catch {
      return reply.status(401).send({
        error: "Unauthorized",
        message: "Invalid refresh token",
      });
    }

    // Find the stored token record
    const [storedToken] = await db
      .select()
      .from(dealerRefreshTokens)
      .where(
        and(
          eq(dealerRefreshTokens.token, body.refreshToken),
          isNull(dealerRefreshTokens.revokedAt)
        )
      )
      .limit(1);

    if (!storedToken) {
      // Token reuse detected — revoke entire family (possible token theft)
      await db
        .update(dealerRefreshTokens)
        .set({ revokedAt: new Date() })
        .where(eq(dealerRefreshTokens.family, payload.family));

      request.log.warn(
        { dealerId: payload.dealerId, family: payload.family },
        "Refresh token reuse detected — entire family revoked"
      );

      return reply.status(401).send({
        error: "Unauthorized",
        message: "Token has been revoked. Please login again.",
      });
    }

    // Revoke old token
    await db
      .update(dealerRefreshTokens)
      .set({ revokedAt: new Date() })
      .where(eq(dealerRefreshTokens.id, storedToken.id));

    // Issue new tokens
    const tokenPayload = {
      dealerId: payload.dealerId,
      phone: payload.phone,
      zoneId: payload.zoneId,
    };

    const newAccessToken = signDealerAccessToken(tokenPayload);
    const newRefreshToken = signDealerRefreshToken({
      ...tokenPayload,
      family: payload.family,
    });

    await db.insert(dealerRefreshTokens).values({
      dealerId: payload.dealerId,
      token: newRefreshToken,
      family: payload.family,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });

    return reply.status(200).send({
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
    });
  });

  // ════════════════════════════════════════════
  // ADMIN AUTH — Email + Password, server-side sessions
  // ════════════════════════════════════════════

  // POST /api/v1/auth/admin/login
  app.post("/api/v1/auth/admin/login", async (request, reply) => {
    const schema = z.object({
      email: z.string().email(),
      password: z.string().min(1),
    });
    const body = schema.parse(request.body);

    // Find user
    const [user] = await db
      .select()
      .from(users)
      .where(and(eq(users.email, body.email), isNull(users.deletedAt)))
      .limit(1);

    if (!user || !user.active) {
      return reply.status(401).send({
        error: "Unauthorized",
        message: "Invalid email or password",
      });
    }

    // Verify password
    const valid = await comparePassword(body.password, user.passwordHash);
    if (!valid) {
      return reply.status(401).send({
        error: "Unauthorized",
        message: "Invalid email or password",
      });
    }

    // Create session
    const token = generateSessionToken();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    await db.insert(adminSessions).values({
      userId: user.id,
      token,
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"] ?? null,
      expiresAt,
    });

    // Update last login
    await db
      .update(users)
      .set({ lastLoginAt: new Date() })
      .where(eq(users.id, user.id));

    // Set httpOnly cookie
    reply.setCookie("hmu_session", token, {
      httpOnly: true,
      secure: env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 24 * 60 * 60, // 24 hours in seconds
    });

    return reply.status(200).send({
      message: "Login successful",
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        zoneId: user.zoneId,
      },
      sessionToken: token, // Also return in body for x-session-token header usage
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
          gt(adminSessions.expiresAt, new Date())
        )
      )
      .limit(1);

    if (!session) {
      return reply.status(401).send({ error: "Unauthorized" });
    }

    const [user] = await db
      .select({
        id: users.id,
        name: users.name,
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
