import type { FastifyRequest, FastifyReply } from "fastify";
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

  try {
    const payload = verifyDealerAccessToken(token);
    request.dealer = {
      dealerId: payload.dealerId,
      phone: payload.phone,
      zoneId: payload.zoneId,
    };
  } catch (err) {
    return reply.status(401).send({
      error: "Unauthorized",
      message: "Invalid or expired access token",
    });
  }
}
