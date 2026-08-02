// ═══════════════════════════════════════════════════════════════════════
// apps/worker/src/index.ts
//
// Background worker: in-process cron (croner, IST) + a Postgres outbox
// poller for jobs enqueued by the API (push notifications, PDF invoices).
//
// WHY NO REDIS/BULLMQ: on per-command-billed Upstash, BullMQ's idle
// polling (8 workers × blocking-wait + Lua move-to-active every ~10s)
// burned ~560K commands/day ≈ $50+/month with zero jobs flowing. The
// outbox table (migration 0060) on the existing Supabase Postgres costs
// nothing and one SELECT every 5s is negligible load.
// ═══════════════════════════════════════════════════════════════════════

import "dotenv/config";
import { Cron } from "croner";
import { sql } from "./lib/db.js";
import { processPushNotification } from "./jobs/push-notification.js";
import { processPDFInvoice } from "./jobs/pdf-invoice.js";
import { processPartitionCreation } from "./jobs/partition-creation.js";
import { processPaymentReminders } from "./jobs/payment-reminders.js";
import { processDispatchPregenerate } from "./jobs/dispatch-pregenerate.js";
import { processMaterializeDrafts } from "./jobs/materialize-drafts.js";
import { processAutoConfirmDrafts } from "./jobs/auto-confirm-drafts.js";
import { processReconcilePayments } from "./jobs/reconcile-payments.js";

console.log("═══════════════════════════════════════");
console.log("  🐄 Haveri Milk Union — Worker");
console.log("═══════════════════════════════════════");

// ── Outbox poller ──────────────────────────────────────────────────────
// Claims due background_jobs rows (FOR UPDATE SKIP LOCKED — safe if a
// second worker instance ever runs), executes them, deletes on success,
// retries with exponential backoff until max_attempts, then parks the
// row as 'failed'. A 'processing' row untouched for 5+ minutes is
// treated as orphaned by a crash and re-claimed.

const POLL_INTERVAL_MS = 5_000;
const CLAIM_BATCH = 10;

interface OutboxRow {
  id: string;
  queue: string;
  name: string;
  data: any;
  attempts: number;
  max_attempts: number;
}

async function claimJobs(): Promise<OutboxRow[]> {
  return await sql<OutboxRow[]>`
    UPDATE background_jobs
       SET status = 'processing', attempts = attempts + 1, updated_at = now()
     WHERE id IN (
       SELECT id FROM background_jobs
        WHERE (status = 'pending' AND run_at <= now())
           OR (status = 'processing' AND updated_at < now() - interval '5 minutes')
        ORDER BY run_at
        LIMIT ${CLAIM_BATCH}
        FOR UPDATE SKIP LOCKED
     )
     RETURNING id, queue, name, data, attempts, max_attempts
  `;
}

async function runOutboxJob(row: OutboxRow): Promise<void> {
  try {
    switch (row.queue) {
      case "push-notifications":
        await processPushNotification({ data: row.data });
        break;
      case "pdf-invoice":
        await processPDFInvoice({ data: row.data });
        break;
      default:
        throw new Error(`Unknown queue: ${row.queue}`);
    }
    await sql`DELETE FROM background_jobs WHERE id = ${row.id}`;
    console.log(`✅ [${row.queue}] ${row.name} done`);
  } catch (err: any) {
    const msg = String(err?.message ?? err).slice(0, 500);
    if (row.attempts >= row.max_attempts) {
      await sql`
        UPDATE background_jobs
           SET status = 'failed', last_error = ${msg}, updated_at = now()
         WHERE id = ${row.id}
      `;
      console.error(`❌ [${row.queue}] ${row.name} permanently failed:`, msg);
    } else {
      const delaySecs = 5 * 2 ** (row.attempts - 1); // 5s, 10s, 20s, …
      await sql`
        UPDATE background_jobs
           SET status = 'pending', last_error = ${msg},
               run_at = now() + make_interval(secs => ${delaySecs}),
               updated_at = now()
         WHERE id = ${row.id}
      `;
      console.warn(`🔁 [${row.queue}] ${row.name} failed (attempt ${row.attempts}/${row.max_attempts}), retrying in ${delaySecs}s:`, msg);
    }
  }
}

let polling = false;
let shuttingDown = false;

async function pollOutbox(): Promise<void> {
  if (polling || shuttingDown) return;
  polling = true;
  try {
    // Drain until empty so bursts (window close) clear immediately.
    for (;;) {
      const jobs = await claimJobs();
      if (jobs.length === 0) break;
      for (const job of jobs) await runOutboxJob(job);
      if (shuttingDown) break;
    }
  } catch (err: any) {
    console.error("⚠️ [Outbox] poll error:", err?.message ?? err);
  } finally {
    polling = false;
  }
}

const pollTimer = setInterval(pollOutbox, POLL_INTERVAL_MS);

// ── Scheduled Jobs (cron, IST — no more UTC offset arithmetic) ────────

const IST = "Asia/Kolkata";
const running = new Set<string>();

/** Serialize runs of the same job: a tick is skipped while the previous
 *  one is still going (BullMQ concurrency:1 equivalent). */
function guarded(name: string, fn: () => Promise<unknown>): () => Promise<void> {
  return async () => {
    if (running.has(name) || shuttingDown) {
      if (running.has(name)) console.warn(`⏭️ [${name}] previous run still active — skipped`);
      return;
    }
    running.add(name);
    try {
      await fn();
      console.log(`✅ [${name}] done`);
    } catch (err: any) {
      console.error(`❌ [${name}] failed:`, err?.message ?? err);
    } finally {
      running.delete(name);
    }
  };
}

function schedule(pattern: string, name: string, fn: () => Promise<unknown>): Cron {
  return new Cron(pattern, { timezone: IST, name }, guarded(name, fn));
}

const crons: Cron[] = [
  // Monthly partition creation — 25th of every month at 2:00 AM IST
  schedule("0 2 25 * *", "Partition", processPartitionCreation),

  // Daily payment reminders — 10:00 AM IST
  schedule("0 10 * * *", "PaymentReminders", processPaymentReminders),

  // Daily dispatch pre-generation — 5:00 AM IST
  schedule("0 5 * * *", "Dispatch", processDispatchPregenerate),

  // Window opening reminder — 5:55 AM IST (broadcast to all dealers)
  schedule("55 5 * * *", "WindowOpening", () =>
    processPushNotification({
      data: { event: "window.opening", title: "Window Opening Soon 🟢", body: "The ordering window opens in 5 minutes!" },
    })
  ),

  // Window closing reminder — 7:45 AM IST (broadcast to all dealers)
  schedule("45 7 * * *", "WindowClosing", () =>
    processPushNotification({
      data: { event: "window.closing", title: "Window Closing Soon ⚠️", body: "Only 15 minutes left to place your indent!" },
    })
  ),

  // Nightly draft materialization — 4:00 AM IST
  schedule("0 4 * * *", "Materialize", processMaterializeDrafts),

  // Auto-confirm drafts at zone close-time — every 5 min (job filters internally)
  schedule("*/5 * * * *", "AutoConfirm", processAutoConfirmDrafts),

  // Reconcile captured-but-unapplied Razorpay payments — every 10 min.
  // The job filters to rows older than a grace period so in-flight
  // checkouts are never touched.
  schedule("*/10 * * * *", "ReconcilePayments", processReconcilePayments),

  // Purge failed outbox rows older than 7 days — 3:30 AM IST
  schedule("30 3 * * *", "OutboxCleanup", async () => {
    const purged = await sql`
      DELETE FROM background_jobs
       WHERE status = 'failed' AND updated_at < now() - interval '7 days'
    `;
    console.log(`[OutboxCleanup] purged ${purged.count} failed jobs`);
  }),
];

// ── Graceful Shutdown ──────────────────────────────────────────────────

async function shutdown() {
  console.log("\n🛑 Shutting down worker...");
  shuttingDown = true;
  clearInterval(pollTimer);
  for (const c of crons) c.stop();

  // Let an in-flight poll/job finish (bounded wait).
  const deadline = Date.now() + 25_000;
  while ((polling || running.size > 0) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
  }

  await sql.end({ timeout: 5 });
  console.log("👋 Worker stopped");
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// ── Start ──────────────────────────────────────────────────────────────

console.log("");
console.log("🚀 Worker running:");
console.log("   • outbox poller        (push-notifications, pdf-invoice — every 5s)");
console.log("   • partition-creation   (25th, 2:00 AM IST)");
console.log("   • payment-reminders    (daily, 10:00 AM IST)");
console.log("   • dispatch-pregenerate (daily, 5:00 AM IST)");
console.log("   • window reminders     (5:55 AM / 7:45 AM IST)");
console.log("   • materialize-drafts   (daily, 4:00 AM IST)");
console.log("   • auto-confirm-drafts  (every 5 min)");
console.log("   • reconcile-payments   (every 10 min)");
console.log("");
console.log("Waiting for jobs...");
