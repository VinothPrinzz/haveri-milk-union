import "dotenv/config";
import { Worker, Queue } from "bullmq";
import { redis } from "./lib/redis.js";
import { processPushNotification } from "./jobs/push-notification.js";
import { processPDFInvoice } from "./jobs/pdf-invoice.js";
import { processPartitionCreation } from "./jobs/partition-creation.js";
import { processPaymentReminders } from "./jobs/payment-reminders.js";
import { processDispatchPregenerate } from "./jobs/dispatch-pregenerate.js";
// import {
//   startPollingReplicator,
//   stopPollingReplicator,
// } from "./polling-replication-bootstrap.js";
import { processMaterializeDrafts } from "./jobs/materialize-drafts.js";
import { processAutoConfirmDrafts } from "./jobs/auto-confirm-drafts.js";
import { closeSharedQueues } from "./lib/queues.js";

console.log("═══════════════════════════════════════");
console.log("  🐄 Haveri Milk Union — BullMQ Worker");
console.log("═══════════════════════════════════════");

const connection = redis;

// ── Shared worker options to slash idle Redis traffic ──
// On a per-request-billed Redis (Upstash) BullMQ's idle polling is the
// dominant cost. These two knobs cut it ~7x with no functional change:
//   • drainDelay: when a queue is empty, block up to 30s before
//     re-polling (default 5s). Adding a job still wakes the worker
//     instantly via the marker key, so job latency is unaffected.
//   • stalledInterval: scan for stalled jobs every 5 min (default 30s).
//     A job orphaned by a worker crash is retried within 5 min — fine
//     for these batch jobs.
const SHARED_WORKER_OPTS = {
  drainDelay: 30,
  stalledInterval: 300_000,
} as const;

// ── Queue Definitions ──
// These are also used by the API to enqueue jobs
const QUEUES = {
  pushNotifications: "push-notifications",
  pdfInvoice: "pdf-invoice",
  partitionCreation: "partition-creation",
  paymentReminders: "payment-reminders",
  dispatchPregenerate: "dispatch-pregenerate",
  materializeDrafts:   "materialize-drafts",
  autoConfirmDrafts:   "auto-confirm-drafts",
} as const;

// ── Workers ──

// 1. Push Notifications — high concurrency for burst during window
const pushWorker = new Worker(
  QUEUES.pushNotifications,
  processPushNotification,
  {
    connection,
    ...SHARED_WORKER_OPTS,
    concurrency: 10, // Handle 10 FCM sends in parallel
    limiter: { max: 100, duration: 1000 }, // Max 100/sec (FCM limit is 500/sec)
  }
);

// 2. PDF Invoice Generation — lower concurrency (CPU intensive)
const pdfWorker = new Worker(
  QUEUES.pdfInvoice,
  processPDFInvoice,
  {
    connection,
    ...SHARED_WORKER_OPTS,
    concurrency: 3,
  }
);

// 3. Monthly Partition Creation
const partitionWorker = new Worker(
  QUEUES.partitionCreation,
  processPartitionCreation,
  {
    connection,
    ...SHARED_WORKER_OPTS,
    concurrency: 1,
  }
);

// 4. Payment Reminders
const paymentWorker = new Worker(
  QUEUES.paymentReminders,
  processPaymentReminders,
  {
    connection,
    ...SHARED_WORKER_OPTS,
    concurrency: 1,
  }
);

// 5. Dispatch Pre-generation
const dispatchWorker = new Worker(
  QUEUES.dispatchPregenerate,
  processDispatchPregenerate,
  {
    connection,
    ...SHARED_WORKER_OPTS,
    concurrency: 1,
  }
);

// 6
const materializeWorker = new Worker(
  QUEUES.materializeDrafts,
  processMaterializeDrafts,
  {
    connection,
    ...SHARED_WORKER_OPTS,
    concurrency: 1, // one batch at a time; the job itself iterates all dealers
  }
);

// 7
const autoConfirmWorker = new Worker(
  QUEUES.autoConfirmDrafts,
  processAutoConfirmDrafts,
  {
    connection,
    ...SHARED_WORKER_OPTS,
    concurrency: 1,
  }
);

// ── Start Polling Replicator (Dual-DB) ──
// await startPollingReplicator();

// ── Scheduled / Repeatable Jobs (Cron) ──
async function setupSchedules() {
  // Monthly partition creation — 25th of every month at 2:00 AM IST
  const partitionQueue = new Queue(QUEUES.partitionCreation, { connection });
  await partitionQueue.upsertJobScheduler(
    "monthly-partition",
    { pattern: "0 20 24 * *" }, // 2 AM IST = 20:30 UTC previous day (approx)
    { name: "create-next-month-partition" }
  );
  console.log("📅 Scheduled: Monthly partition creation (25th, 2:00 AM)");

  // Daily payment reminders — every day at 10:00 AM IST
  const paymentQueue = new Queue(QUEUES.paymentReminders, { connection });
  await paymentQueue.upsertJobScheduler(
    "daily-payment-reminders",
    { pattern: "30 4 * * *" }, // 10:00 AM IST = 4:30 UTC
    { name: "check-overdue-payments" }
  );
  console.log("📅 Scheduled: Daily payment reminders (10:00 AM IST)");

  // Daily dispatch pre-generation — every day at 5:00 AM IST
  const dispatchQueue = new Queue(QUEUES.dispatchPregenerate, { connection });
  await dispatchQueue.upsertJobScheduler(
    "daily-dispatch",
    { pattern: "30 23 * * *" }, // 5:00 AM IST = 23:30 UTC previous day
    { name: "pregenerate-dispatch-sheet" }
  );
  console.log("📅 Scheduled: Daily dispatch pre-generation (5:00 AM IST)");

  // Window opening reminder — every day at 5:55 AM IST
  const pushQueue = new Queue(QUEUES.pushNotifications, { connection });
  await pushQueue.upsertJobScheduler(
    "window-opening-reminder",
    { pattern: "25 0 * * *" }, // 5:55 AM IST = 0:25 UTC
    {
      name: "window-opening",
      data: { event: "window.opening", title: "Window Opening Soon 🟢", body: "The ordering window opens in 5 minutes!" },
    }
  );
  console.log("📅 Scheduled: Window opening reminder (5:55 AM IST)");

  // Window closing reminder — every day at 7:45 AM IST
  await pushQueue.upsertJobScheduler(
    "window-closing-reminder",
    { pattern: "15 2 * * *" }, // 7:45 AM IST = 2:15 UTC
    {
      name: "window-closing",
      data: { event: "window.closing", title: "Window Closing Soon ⚠️", body: "Only 15 minutes left to place your indent!" },
    }
  );
  console.log("📅 Scheduled: Window closing reminder (7:45 AM IST)");

  // Nightly draft materialization — every day at 04:00 IST
  // 04:00 IST = 22:30 UTC (previous day). Pattern is in UTC.
  const materializeQueue = new Queue(QUEUES.materializeDrafts, { connection });
  await materializeQueue.upsertJobScheduler(
    "nightly-materialize-drafts",
    { pattern: "30 22 * * *" }, // 22:30 UTC = 04:00 IST
    { name: "build-tomorrow-drafts" }
  );
  console.log("📅 Scheduled: Nightly draft materialization (04:00 AM IST)");
  
  // Auto-confirm drafts at zone close-time — every 5 minutes
  const autoConfirmQueue = new Queue(QUEUES.autoConfirmDrafts, { connection });
  await autoConfirmQueue.upsertJobScheduler(
    "auto-confirm-drafts",
    { pattern: "*/5 * * * *" }, // every 5 min, the job filters internally
    { name: "auto-confirm-on-close" }
  );
  console.log("📅 Scheduled: Auto-confirm at window close (every 5 min)");
}

// ── Event Logging ──

const workers = [
  pushWorker,
  pdfWorker,
  partitionWorker,
  paymentWorker,
  dispatchWorker,
  materializeWorker,
  autoConfirmWorker,
];
const names = [
  "Push",
  "PDF",
  "Partition",
  "Payment",
  "Dispatch",
  "Materialize",
  "AutoConfirm",
];

workers.forEach((w, i) => {
  w.on("completed", (job) => {
    console.log(`✅ [${names[i]}] Job ${job.id} completed`);
  });
  w.on("failed", (job, err) => {
    console.error(`❌ [${names[i]}] Job ${job?.id} failed:`, err.message);
  });
  w.on("error", (err) => {
    console.error(`⚠️ [${names[i]}] Worker error:`, err.message);
  });
});

// ── Graceful Shutdown ──

async function shutdown() {
  console.log("\n🛑 Shutting down workers...");

  // await stopPollingReplicator();

  await Promise.all(workers.map((w) => w.close()));
  await closeSharedQueues();
  await redis.quit();
  console.log("👋 Worker stopped");
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// ── Start ──

setupSchedules()
  .then(() => {
    console.log("");
    console.log("🚀 All workers running:");
    console.log("   • push-notifications  (concurrency: 10)");
    console.log("   • pdf-invoice         (concurrency: 3, 3 retries)");
    console.log("   • partition-creation   (concurrency: 1, 3 retries)");
    console.log("   • payment-reminders   (concurrency: 1)");
    console.log("   • dispatch-pregenerate (concurrency: 1)");
    console.log("   • materialize-drafts   (concurrency: 1)");
    console.log("   • auto-confirm-drafts  (concurrency: 1)");
    console.log("");
    console.log("Waiting for jobs...");
  })
  .catch((err) => {
    console.error("Failed to setup schedules:", err);
  });
