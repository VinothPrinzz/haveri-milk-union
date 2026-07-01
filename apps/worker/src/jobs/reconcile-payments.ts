// ═══════════════════════════════════════════════════════════════════════
// apps/worker/src/jobs/reconcile-payments.ts
//
// Periodically triggers the API's payment-reconciliation sweep, which finds
// Razorpay payments that were captured but never applied (the app's
// synchronous /verify didn't complete AND the webhook didn't land) and
// applies them through the live path.
//
// The reconcile logic itself lives in the API (apps/api/.../payment-
// reconciliation.ts) so it can reuse applyPaidPayment() — the single source
// of truth for ledger/stock/invoice effects. This job is just the cron
// trigger. It logs LOUDLY on misconfiguration or failure so this safety net
// can never silently rot the way the webhook did.
//
// Requires env: API_INTERNAL_URL (base URL of the API, e.g.
// https://api.example.com) and INTERNAL_JOB_SECRET (shared with the API).
// ═══════════════════════════════════════════════════════════════════════

import { Job } from "bullmq";

export async function processReconcilePayments(_job: Job) {
  const base = process.env.API_INTERNAL_URL || process.env.API_URL;
  const secret = process.env.INTERNAL_JOB_SECRET;

  if (!base || !secret) {
    console.error(
      "[ReconcilePayments] MISCONFIGURED — set API_INTERNAL_URL and INTERNAL_JOB_SECRET so captured-but-unapplied payments get recovered. Skipping this run."
    );
    return { skipped: "misconfigured" as const };
  }

  const url = `${base.replace(/\/+$/, "")}/api/v1/internal/reconcile-razorpay`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "x-internal-secret": secret,
        "content-type": "application/json",
      },
    });
  } catch (err) {
    console.error(
      "[ReconcilePayments] could not reach the reconcile endpoint:",
      err instanceof Error ? err.message : err
    );
    throw err; // surface as a failed BullMQ job
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error(
      `[ReconcilePayments] reconcile endpoint returned ${res.status} ${res.statusText}: ${text}`
    );
    throw new Error(`reconcile HTTP ${res.status}`);
  }

  const body: any = await res.json().catch(() => ({}));
  if ((body.applied ?? 0) > 0 || (body.errors ?? 0) > 0) {
    console.log(
      `[ReconcilePayments] scanned=${body.scanned} applied=${body.applied} ` +
        `alreadyApplied=${body.alreadyApplied} noCapture=${body.noCapture} errors=${body.errors}`
    );
  }
  return body;
}
