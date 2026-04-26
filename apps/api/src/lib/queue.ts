import { Queue } from "bullmq";
import { Redis as IORedis } from "ioredis";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

let redis: IORedis | null = null;
const queues: Record<string, Queue> = {};

function getRedis(): IORedis {
  if (!redis) {
    redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false });
  }
  return redis;
}

function getQueue(name: string): Queue {
  if (!queues[name]) {
    queues[name] = new Queue(name, { connection: getRedis() });
  }
  return queues[name]!;
}

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
    await getQueue("push-notifications").add(`push-${data.event}`, data, {
      removeOnComplete: 100,
      removeOnFail: 500,
    });
  } catch (err) {
    console.warn("[Queue] Failed to enqueue push notification:", err);
    // Don't throw — push notifications are non-critical
  }
}

/**
 * Enqueue PDF invoice generation after an order is placed.
 */
export async function enqueuePDFInvoice(orderId: string) {
  try {
    await getQueue("pdf-invoice").add(`invoice-${orderId.slice(0, 8)}`, { orderId }, {
      removeOnComplete: 100,
      removeOnFail: 500,
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
    });
  } catch (err) {
    console.warn("[Queue] Failed to enqueue PDF generation:", err);
  }
}

/**
 * Clean up Redis connections on shutdown.
 */
export async function closeQueues() {
  for (const q of Object.values(queues)) {
    await q.close();
  }
  if (redis) await redis.quit();
}
