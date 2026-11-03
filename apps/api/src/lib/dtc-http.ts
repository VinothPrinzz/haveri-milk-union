// apps/api/src/lib/dtc-http.ts
// Route registration for the DTC Billing endpoints: auth + permission guard,
// and HttpError → a 4xx with a readable message (the global error handler
// hides messages in production, which is right for 500s but not for "this
// month is already approved").
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import { adminAuth, requireRole } from "../middleware/admin-auth.js";
import { HttpError } from "./dtc.js";

type Handler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

export function dtcRoute(
  app: FastifyInstance,
  method: "get" | "post" | "put" | "patch" | "delete",
  url: string,
  permission: string,
  handler: Handler,
) {
  app[method](url, { preHandler: [adminAuth, requireRole(permission)] }, async (request, reply) => {
    try {
      return await handler(request, reply);
    } catch (e) {
      if (e instanceof HttpError) return reply.status(e.status).send({ error: e.title, message: e.message });
      if ((e as any)?.code === "23505") {
        return reply.status(409).send({ error: "Duplicate", message: "That record already exists." });
      }
      throw e;
    }
  });
}

/** zod parse that answers 400 with the first issue spelled out. */
export function parseWith<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const i = r.error.issues[0];
    const path = i?.path.join(".") ?? "";
    const msg = i?.message ?? "Invalid request";
    throw new HttpError(400, "Validation Error", path ? `${path}: ${msg}` : msg);
  }
  return r.data;
}
