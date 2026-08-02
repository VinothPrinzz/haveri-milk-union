// ═══════════════════════════════════════════════════════════════════════
// apps/worker/src/lib/queues.ts
//
// Background-job enqueue helpers, writing rows to the background_jobs
// outbox table (migration 0060). The poller in index.ts claims and runs
// them within ~5s.
//
// WHY: this used to hold shared BullMQ Queue singletons on Upstash
// Redis. BullMQ's idle polling on per-command billing cost ~$50/month
// with zero jobs flowing; the outbox on the existing Postgres costs $0.
// ═══════════════════════════════════════════════════════════════════════

import { sql } from "./db.js";
import type { PushNotificationJobData } from "../jobs/push-notification.js";

/** Minimal shape handed to job processors (was BullMQ's Job). */
export interface JobLike<T = unknown> {
  data: T;
}

/** Enqueue a push notification (sent once — no retry, same as before). */
export async function enqueuePush(name: string, data: PushNotificationJobData): Promise<void> {
  await sql`
    INSERT INTO background_jobs (queue, name, data)
    VALUES ('push-notifications', ${name}, ${JSON.stringify(data)}::jsonb)
  `;
}

/** Enqueue PDF invoice generation (retried up to 3 times with backoff). */
export async function enqueuePdf(orderId: string): Promise<void> {
  await sql`
    INSERT INTO background_jobs (queue, name, data, max_attempts)
    VALUES ('pdf-invoice', ${`invoice-${orderId.slice(0, 8)}`}, ${JSON.stringify({ orderId })}::jsonb, 3)
  `;
}
