// ════════════════════════════════════════════════════════════════════
// apps/api/src/lib/queue.ts
//
// Background-job enqueue helpers. Jobs are rows in the background_jobs
// outbox table (migration 0060) on the existing Postgres — the worker
// polls it every ~5s. This replaced BullMQ/Redis: on per-command-billed
// Upstash, BullMQ's idle polling alone cost ~$50/month.
// ════════════════════════════════════════════════════════════════════

import { pgClient as sql } from "./db.js";

/**
 * Enqueue a push notification to be sent by the worker.
 */
export async function enqueuePushNotification(data: {
  event: "order.confirmed" | "order.dispatched" | "window.opening" | "window.closing" | "payment.reminder" | "custom";
  dealerId?: string;
  zoneId?: string;
  orderId?: string;
  title?: string;
  body?: string;
}) {
  try {
    await sql`
      INSERT INTO background_jobs (queue, name, data)
      VALUES ('push-notifications', ${`push-${data.event}`}, ${JSON.stringify(data)}::jsonb)
    `;
  } catch (err) {
    console.warn("[Queue] Failed to enqueue push notification:", err);
    // Don't throw — push notifications are non-critical
  }
}

/**
 * Enqueue PDF invoice generation after an order is placed.
 * Retried up to 3 times with exponential backoff by the worker.
 */
export async function enqueuePDFInvoice(orderId: string) {
  try {
    await sql`
      INSERT INTO background_jobs (queue, name, data, max_attempts)
      VALUES ('pdf-invoice', ${`invoice-${orderId.slice(0, 8)}`}, ${JSON.stringify({ orderId })}::jsonb, 3)
    `;
  } catch (err) {
    console.warn("[Queue] Failed to enqueue PDF generation:", err);
  }
}
