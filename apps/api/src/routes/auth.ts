import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, and, sql, gt, isNull } from "drizzle-orm";
import { db } from "../lib/db.js";
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
  generateSessionToken,
} from "../lib/auth.js";

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

    console.log("=== LOGIN DEBUG ===");
    console.log("Input username:", username);
    
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

    console.log("Found dealer:", !!dealer);
    if (dealer) {
      console.log("Dealer ID:", dealer.id);
      console.log("Active:", dealer.active);
      console.log("DeletedAt:", dealer.deletedAt);
      console.log("Has passwordHash:", !!dealer.passwordHash);
      console.log("Hash length:", dealer.passwordHash?.length);
    }

    if (!dealer) {
      return reply.status(401).send({ error: "Unauthorized", message: "Invalid username or password" });
    }
  
    if (!dealer.active) {
      console.log("❌ Dealer is NOT ACTIVE");
      return reply.status(401).send({ error: "Unauthorized", message: "Account is inactive" });
    }
  
    if (dealer.deletedAt) {
      console.log("❌ Dealer is deleted");
      return reply.status(401).send({ error: "Unauthorized", message: "Invalid username or password" });
    }

    const passwordMatch = await comparePassword(password, dealer.passwordHash || "");
    console.log("Password match:", passwordMatch);
    if (!passwordMatch) {
      return reply.status(401).send({
        error: "Unauthorized",
        message: "Invalid username or password",
      });
    }

    // === If we reach here → should succeed ===
    console.log("✅ All checks passed, generating tokens...");

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

    console.log("✅ Login successful for dealer:", dealer.id);

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
