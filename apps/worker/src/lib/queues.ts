// ═══════════════════════════════════════════════════════════════════════
// apps/worker/src/lib/queues.ts
//
// Shared producer Queue singletons, created ONCE at module load and
// reused by every job handler.
//
// WHY: jobs used to do `new Queue(...)` + `.close()` on every run. On a
// per-request-billed Redis (Upstash) each create/close re-authenticates
// and re-handshakes a connection — pure waste, multiplied by the
// 5-minute auto-confirm cadence. Reusing one connection (the shared
// `redis` instance) removes that churn entirely.
// ═══════════════════════════════════════════════════════════════════════

import { Queue } from "bullmq";
import { redis } from "./redis.js";

export const pushQueue = new Queue("push-notifications", { connection: redis });
export const pdfQueue = new Queue("pdf-invoice", { connection: redis });

export async function closeSharedQueues(): Promise<void> {
  await Promise.all([pushQueue.close(), pdfQueue.close()]);
}
