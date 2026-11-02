import type { FastifyInstance } from "fastify";
import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { eq, and, ne, sql, gt, lt, isNull, desc } from "drizzle-orm";
import { db } from "../lib/db.js";
import {
  dealers,
  dealerOtps,
  dealerRefreshTokens,
  users,
  adminSessions,
} from "@hmu/db/schema";
import { env } from "../lib/env.js";
import {
  sendSms,
  isSmsConfigured,
  normalizeIndianMobile,
  SmsNotConfiguredError,
} from "../lib/sms.js";
import {
  signDealerAccessToken,
  signDealerRefreshToken,
  comparePassword,
  hashPassword,
  generateSessionToken,
  verifyDealerRefreshToken,
} from "../lib/auth.js";
import { adminAuth } from "../middleware/admin-auth.js";

// ── Dealer OTP policy ──
const OTP_TTL_SECONDS = 5 * 60;
const OTP_RESEND_SECONDS = 60;
const OTP_MAX_PER_HOUR = 5;
const OTP_MAX_ATTEMPTS = 5;

/** Keyed hash so a DB leak doesn't expose live OTPs (6 digits is trivially brute-forced unkeyed). */
function hashOtp(phone: string, otp: string): string {
  return createHmac("sha256", env.JWT_SECRET).update(`${phone}:${otp}`).digest("hex");
}

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

    // Return a MINIMAL dealer payload only. The app calls
    // GET /api/v1/dealer/profile immediately after login and treats that
    // as the source of truth for name/zone/wallet/credit, discarding this
    // object unless that follow-up fetch fails. Running the full profile
    // query here (multi-JOIN + correlated SUM-over-orders subquery) just
    // bloated and slowed the one response that must beat the mobile
    // client's network timeout on slow connections. zoneId comes free from
    // the auth lookup above, so we include it to keep the window query
    // working even in the rare fallback case.
    return reply.send({
      accessToken,
      refreshToken,
      dealer: { id: dealer.id, phone: dealer.phone, zone_id: dealer.zoneId },
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

    // A deleted / deactivated dealer must not be able to mint new access
    // tokens. Kill every outstanding refresh token so the session ends here.
    const [dealer] = await db
      .select({ active: dealers.active, deletedAt: dealers.deletedAt })
      .from(dealers)
      .where(eq(dealers.id, row.dealerId))
      .limit(1);

    if (!dealer || !dealer.active || dealer.deletedAt) {
      await db
        .update(dealerRefreshTokens)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(dealerRefreshTokens.dealerId, row.dealerId),
            isNull(dealerRefreshTokens.revokedAt)
          )
        );
      return reply.status(401).send({ error: "Unauthorized", message: "Account is inactive or deleted" });
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

  // POST /api/v1/auth/dealer/change-password
  // Self-service: a dealer changes their OWN password from the login screen
  // after proving they know their current one. No OTP / SMS — the dealer
  // supplies username + current password + new password. This replaces the
  // old "Forgot Password" link in the dealer app. Unauthenticated by design
  // (the dealer isn't signed in when they use it); the current-password
  // check is what authorises the change.
  app.post("/api/v1/auth/dealer/change-password", async (request, reply) => {
    const schema = z.object({
      username: z.string().min(1),
      currentPassword: z.string().min(1),
      newPassword: z
        .string()
        .min(6, "New password must be at least 6 characters"),
    });
    const { username, currentPassword, newPassword } = schema.parse(
      request.body
    );

    const [dealer] = await db
      .select({
        id: dealers.id,
        passwordHash: dealers.passwordHash,
        active: dealers.active,
        deletedAt: dealers.deletedAt,
      })
      .from(dealers)
      .where(and(eq(dealers.username, username), isNull(dealers.deletedAt)))
      .limit(1);

    // Same generic message as login so we don't leak which usernames exist.
    if (!dealer || !dealer.active || dealer.deletedAt) {
      return reply
        .status(401)
        .send({ error: "Unauthorized", message: "Invalid username or password" });
    }

    const valid = await comparePassword(
      currentPassword,
      dealer.passwordHash || ""
    );
    if (!valid) {
      return reply
        .status(401)
        .send({ error: "Unauthorized", message: "Current password is incorrect" });
    }

    // Disallow reusing the same password.
    const same = await comparePassword(newPassword, dealer.passwordHash || "");
    if (same) {
      return reply.status(400).send({
        error: "Bad Request",
        message: "New password must be different from your current password",
      });
    }

    const newHash = await hashPassword(newPassword);
    await db
      .update(dealers)
      .set({ passwordHash: newHash, updatedAt: new Date() })
      .where(eq(dealers.id, dealer.id));

    // Security: revoke every outstanding refresh token for this dealer so
    // any device still signed in with the old password must re-authenticate.
    await db
      .update(dealerRefreshTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(dealerRefreshTokens.dealerId, dealer.id),
          isNull(dealerRefreshTokens.revokedAt)
        )
      );

    return reply.status(200).send({ message: "Password changed successfully" });
  });

  // ─────────────────────────────────────────────────────────────
  // DEALER PASSWORD CHANGE VIA SMS OTP
  // Two steps: request an OTP to the dealer's registered phone, then
  // submit it with the new password. Proving phone possession replaces
  // the current-password check, so this also covers "forgot password".
  // The current-password route above is kept for older app builds.
  //
  // OTPs live in dealer_otps keyed by phone; `otp` stores an HMAC of the
  // code (never the code itself), and only the newest row per phone is
  // ever accepted — requesting a new OTP implicitly voids older ones.
  // ─────────────────────────────────────────────────────────────

  // POST /api/v1/auth/dealer/otp/request
  app.post("/api/v1/auth/dealer/otp/request", async (request, reply) => {
    const { username } = z
      .object({ username: z.string().trim().min(1) })
      .parse(request.body);

    if (!isSmsConfigured()) {
      return reply.status(503).send({
        error: "Service Unavailable",
        message: "OTP service is not available right now. Please contact the union office.",
      });
    }

    const [dealer] = await db
      .select({ id: dealers.id, phone: dealers.phone, active: dealers.active })
      .from(dealers)
      .where(and(eq(dealers.username, username), isNull(dealers.deletedAt)))
      .limit(1);

    if (!dealer || !dealer.active) {
      return reply.status(404).send({
        error: "Not Found",
        message: "No active account found for this username",
      });
    }
    const mobile = normalizeIndianMobile(dealer.phone);
    if (!mobile) {
      return reply.status(400).send({
        error: "Bad Request",
        message: "No valid mobile number is registered for this account. Please contact the union office.",
      });
    }

    // Throttle per phone: one OTP per resend window, capped per hour.
    const recent = await db
      .select({ createdAt: dealerOtps.createdAt })
      .from(dealerOtps)
      .where(
        and(
          eq(dealerOtps.phone, dealer.phone),
          gt(dealerOtps.createdAt, new Date(Date.now() - 60 * 60 * 1000))
        )
      )
      .orderBy(desc(dealerOtps.createdAt));

    const sinceLast = recent[0]
      ? Math.floor((Date.now() - recent[0].createdAt.getTime()) / 1000)
      : Infinity;
    if (sinceLast < OTP_RESEND_SECONDS) {
      const retryAfter = OTP_RESEND_SECONDS - sinceLast;
      return reply.status(429).send({
        error: "Too Many Requests",
        message: `Please wait ${retryAfter} seconds before requesting another OTP`,
        retryAfterSeconds: retryAfter,
      });
    }
    if (recent.length >= OTP_MAX_PER_HOUR) {
      return reply.status(429).send({
        error: "Too Many Requests",
        message: "Too many OTP requests. Please try again after an hour.",
      });
    }

    // Housekeeping: old rows for this phone are never read again.
    await db
      .delete(dealerOtps)
      .where(
        and(
          eq(dealerOtps.phone, dealer.phone),
          lt(dealerOtps.createdAt, new Date(Date.now() - 24 * 60 * 60 * 1000))
        )
      );

    const otp = randomInt(0, 1_000_000).toString().padStart(6, "0");
    const [row] = await db
      .insert(dealerOtps)
      .values({
        phone: dealer.phone,
        otp: hashOtp(dealer.phone, otp),
        expiresAt: new Date(Date.now() + OTP_TTL_SECONDS * 1000),
      })
      .returning({ id: dealerOtps.id });

    try {
      await sendSms(dealer.phone, env.SMS_OTP_MESSAGE.replace("{otp}", otp), { otp });
    } catch (err) {
      // Don't leave an undeliverable OTP counting against the throttle.
      if (row) await db.delete(dealerOtps).where(eq(dealerOtps.id, row.id));
      request.log.error({ err, dealerId: dealer.id }, "dealer OTP SMS failed");
      return reply.status(err instanceof SmsNotConfiguredError ? 503 : 502).send({
        error: "Bad Gateway",
        message: "Could not send OTP SMS. Please try again in a few minutes.",
      });
    }

    return reply.send({
      message: "OTP sent",
      maskedPhone: `******${mobile.slice(-4)}`,
      expiresInSeconds: OTP_TTL_SECONDS,
      resendAfterSeconds: OTP_RESEND_SECONDS,
    });
  });

  // POST /api/v1/auth/dealer/otp/reset-password
  app.post("/api/v1/auth/dealer/otp/reset-password", async (request, reply) => {
    const { username, otp, newPassword } = z
      .object({
        username: z.string().trim().min(1),
        otp: z.string().regex(/^\d{6}$/, "OTP must be 6 digits"),
        newPassword: z
          .string()
          .min(6, "New password must be at least 6 characters"),
      })
      .parse(request.body);

    const invalid = (message = "OTP is invalid or has expired. Please request a new one.") =>
      reply.status(400).send({ error: "Bad Request", message });

    const [dealer] = await db
      .select({ id: dealers.id, phone: dealers.phone, active: dealers.active })
      .from(dealers)
      .where(and(eq(dealers.username, username), isNull(dealers.deletedAt)))
      .limit(1);
    if (!dealer || !dealer.active) return invalid();

    const [latest] = await db
      .select()
      .from(dealerOtps)
      .where(eq(dealerOtps.phone, dealer.phone))
      .orderBy(desc(dealerOtps.createdAt))
      .limit(1);

    const attempts = latest ? Number(latest.attempts) : 0;
    if (
      !latest ||
      latest.verified ||
      latest.expiresAt.getTime() < Date.now() ||
      attempts >= OTP_MAX_ATTEMPTS
    ) {
      return invalid();
    }

    const expected = Buffer.from(latest.otp, "hex");
    const given = Buffer.from(hashOtp(dealer.phone, otp), "hex");
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      await db
        .update(dealerOtps)
        .set({ attempts: sql`${dealerOtps.attempts} + 1` })
        .where(eq(dealerOtps.id, latest.id));
      const left = OTP_MAX_ATTEMPTS - attempts - 1;
      return invalid(
        left > 0
          ? `Incorrect OTP. ${left} attempt${left === 1 ? "" : "s"} left.`
          : "Incorrect OTP. Please request a new one."
      );
    }

    // Consume atomically so two concurrent submits can't both succeed.
    const consumed = await db
      .update(dealerOtps)
      .set({ verified: true })
      .where(and(eq(dealerOtps.id, latest.id), eq(dealerOtps.verified, false)))
      .returning({ id: dealerOtps.id });
    if (consumed.length === 0) return invalid();

    const newHash = await hashPassword(newPassword);
    await db
      .update(dealers)
      .set({ passwordHash: newHash, updatedAt: new Date() })
      .where(eq(dealers.id, dealer.id));

    // Sign out every device, same as the current-password route.
    await db
      .update(dealerRefreshTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(dealerRefreshTokens.dealerId, dealer.id),
          isNull(dealerRefreshTokens.revokedAt)
        )
      );

    return reply.send({ message: "Password changed successfully" });
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
