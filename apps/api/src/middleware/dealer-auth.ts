import type { FastifyRequest, FastifyReply } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "../lib/db.js";
import { dealers } from "@hmu/db/schema";
import { verifyDealerAccessToken } from "../lib/auth.js";

/**
 * Dealer auth middleware — extracts and verifies JWT from Authorization header.
 * Sets request.dealer with { dealerId, phone, zoneId }.
 *
 * Usage in route: { preHandler: [dealerAuth] }
 */

declare module "fastify" {
  interface FastifyRequest {
    dealer?: {
      dealerId: string;
      phone: string;
      zoneId: string;
    };
  }
}

export async function dealerAuth(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const authHeader = request.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    return reply.status(401).send({
      error: "Unauthorized",
      message: "Missing or invalid Authorization header",
    });
  }

  const token = authHeader.slice(7);

  let payload: ReturnType<typeof verifyDealerAccessToken>;
  try {
    payload = verifyDealerAccessToken(token);
  } catch (err) {
    return reply.status(401).send({
      error: "Unauthorized",
      message: "Invalid or expired access token",
    });
  }

  // The JWT alone only proves the dealer existed when it was issued. Confirm
  // the account is still live on every request — otherwise a dealer deleted
  // or deactivated from the admin panel keeps full access (indents, payments)
  // for as long as their app holds a token.
  try {
    const [dealer] = await db
      .select({ active: dealers.active, deletedAt: dealers.deletedAt })
      .from(dealers)
      .where(eq(dealers.id, payload.dealerId))
      .limit(1);

    if (!dealer || !dealer.active || dealer.deletedAt) {
      return reply.status(401).send({
        error: "Unauthorized",
        message: "Account is inactive or deleted",
      });
    }
  } catch (err) {
    request.log.error(err, "Dealer auth middleware error");
    return reply.status(500).send({
      error: "Internal Server Error",
      message: "Authentication check failed",
    });
  }

  request.dealer = {
    dealerId: payload.dealerId,
    phone: payload.phone,
    zoneId: payload.zoneId,
  };
}
