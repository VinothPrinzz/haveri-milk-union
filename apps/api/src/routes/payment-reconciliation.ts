// ═══════════════════════════════════════════════════════════════════════
// apps/api/src/routes/payment-reconciliation.ts
//
// Safety-net #2 for online payments.
//
// The primary paths that apply a Razorpay payment are (1) the mobile app's
// synchronous /pay-now/verify call and (2) the webhook. When BOTH miss —
// the app is closed/loses network right after the money is captured AND the
// webhook doesn't land — the payment sits captured on Razorpay but the
// order stays 'payment_required' and the dealer is never credited. That is
// exactly what stranded orders like HMU-1BFF (order_T86nktGk8E4320) and
// order_T884W4w9YRtka1 required manual one-off scripts to repair.
//
// This scans razorpay_payments rows still 'created'/'attempted'/'failed'
// after a grace period, asks Razorpay whether any attempt actually captured,
// and if so applies it through the SAME live path (applyPaidPayment) — no
// duplicated ledger/stock/invoice logic. 'failed' is included because the
// /verify path can mark a row 'failed' when it merely couldn't reach Razorpay
// to confirm (not a real failure); such a row must stay recoverable.
// Idempotent: applyPaidPayment keys off the internal payments.reference, so
// re-runs are no-ops.
//
// A third pass catches 'paid' rows whose ORDER never advanced (receipt
// booked but the order stuck in payment_required — or auto-discarded at
// window close): the HMU-2A9B / pay_T9JpSPmjHL5BBW failure mode.
//
// Triggered on a schedule by the worker (POST /api/v1/internal/reconcile-
// razorpay, guarded by INTERNAL_JOB_SECRET) and safe to invoke manually.
// ═══════════════════════════════════════════════════════════════════════

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pgClient } from "../lib/db.js";
import {
  isRazorpayConfigured,
  fetchRazorpayOrderPayments,
  captureRazorpayPayment,
} from "../lib/razorpay-client.js";
import { applyPaidPayment, AUTO_DISCARD_REASON } from "./dealer-payments.js";

interface ReconcileItem {
  rzpRowId: string;
  rzpOrderId: string;
  orderId: string | null;
  outcome:
    | "applied"
    | "already-applied"
    | "no-capture"
    | "amount-mismatch"
    | "fetch-error"
    | "apply-error";
  paymentId?: string;
  amount?: number;
  detail?: string;
}

export interface ReconcileSummary {
  scanned: number;
  applied: number;
  alreadyApplied: number;
  noCapture: number;
  errors: number;
  items: ReconcileItem[];
  skipped?: string;
}

/**
 * Scan stuck razorpay_payments and apply any that actually captured money.
 *
 * @param olderThanMinutes only consider rows created before now - N minutes
 *        (default 10) so genuinely in-flight checkouts aren't touched.
 * @param maxAgeHours ignore rows older than this (default 168 = 7 days) so
 *        the periodic sweep stays bounded and doesn't re-poll Razorpay for
 *        ancient abandoned checkouts forever. The one-time historical
 *        backlog is handled by the manual diag-stuck-payments triage.
 * @param limit  cap the batch size (default 100).
 */
export async function reconcileStuckRazorpayPayments(opts?: {
  olderThanMinutes?: number | undefined;
  maxAgeHours?: number | undefined;
  limit?: number | undefined;
}): Promise<ReconcileSummary> {
  const olderThanMinutes = opts?.olderThanMinutes ?? 10;
  const maxAgeHours = opts?.maxAgeHours ?? 168;
  const limit = opts?.limit ?? 100;

  const summary: ReconcileSummary = {
    scanned: 0,
    applied: 0,
    alreadyApplied: 0,
    noCapture: 0,
    errors: 0,
    items: [],
  };

  if (!isRazorpayConfigured()) {
    summary.skipped = "razorpay-unconfigured";
    return summary;
  }

  // Include 'failed' rows, not just created/attempted. The synchronous
  // /verify path marks a row 'failed' when it truly fails — but ALSO used to
  // when it simply couldn't reach Razorpay to confirm (a timeout), which is
  // NOT proof the money wasn't taken. Those poisoned rows must stay
  // recoverable here as the last automatic backstop when the webhook also
  // misses. Re-checking a genuinely-failed row is harmless: Razorpay reports
  // no captured attempt, so it's left untouched (counted as no-capture). The
  // status-flip UPDATE below already guards on 'failed', so this is safe.
  const rows = await pgClient`
    SELECT id::text AS id,
           razorpay_order_id  AS "rzpOrderId",
           razorpay_payment_id AS "rzpPaymentId",
           order_id::text     AS "orderId",
           amount::numeric    AS amount,
           status::text       AS status
      FROM razorpay_payments
     WHERE status IN ('created', 'attempted', 'failed')
       AND created_at < now() - make_interval(mins => ${olderThanMinutes})
       AND created_at > now() - make_interval(hours => ${maxAgeHours})
     ORDER BY created_at ASC
     LIMIT ${limit}
  `;

  summary.scanned = rows.length;

  for (const row of rows as any[]) {
    const expectedPaise = Math.round(parseFloat(row.amount) * 100);

    // 1. Ask Razorpay which attempts exist for this order.
    let payments;
    try {
      payments = await fetchRazorpayOrderPayments(row.rzpOrderId);
    } catch (err) {
      summary.errors++;
      summary.items.push({
        rzpRowId: row.id,
        rzpOrderId: row.rzpOrderId,
        orderId: row.orderId,
        outcome: "fetch-error",
        detail: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    // 2. Find a captured attempt; capture an authorized one if that's all
    //    there is (manual-capture accounts leave money only authorized).
    let captured = payments.find((p) => p.status === "captured");
    if (!captured) {
      const authorized = payments.find((p) => p.status === "authorized");
      if (authorized) {
        try {
          const cap = await captureRazorpayPayment(
            authorized.id,
            authorized.amount,
            authorized.currency || "INR"
          );
          if (cap.status === "captured") captured = { ...authorized, status: "captured" };
        } catch {
          /* fall through — treated as no-capture below */
        }
      }
    }

    if (!captured) {
      summary.noCapture++;
      summary.items.push({
        rzpRowId: row.id,
        rzpOrderId: row.rzpOrderId,
        orderId: row.orderId,
        outcome: "no-capture",
      });
      continue;
    }

    // 3. Amount must match what we charged for — never apply a mismatched
    //    payment automatically.
    if (captured.amount !== expectedPaise) {
      summary.errors++;
      summary.items.push({
        rzpRowId: row.id,
        rzpOrderId: row.rzpOrderId,
        orderId: row.orderId,
        outcome: "amount-mismatch",
        paymentId: captured.id,
        detail: `razorpay ${captured.amount} paise vs expected ${expectedPaise}`,
      });
      continue;
    }

    // 4. Flip the gateway row to paid, pointing at the CAPTURED payment id
    //    (overwrite, not COALESCE — a prior failed attempt may occupy it),
    //    then apply through the live path. Include 'failed' so a poisoned
    //    row is recoverable.
    try {
      await pgClient`
        UPDATE razorpay_payments
           SET status = 'paid',
               razorpay_payment_id = ${captured.id},
               paid_at = COALESCE(paid_at, now()),
               updated_at = now()
         WHERE id = ${row.id}::uuid
           AND status IN ('created', 'attempted', 'failed')
      `;

      const applied = await applyPaidPayment(row.id);
      if (applied.alreadyApplied) {
        summary.alreadyApplied++;
      } else {
        summary.applied++;
      }
      summary.items.push({
        rzpRowId: row.id,
        rzpOrderId: row.rzpOrderId,
        orderId: row.orderId,
        outcome: applied.alreadyApplied ? "already-applied" : "applied",
        paymentId: captured.id,
        amount: applied.amount,
      });
    } catch (err) {
      summary.errors++;
      summary.items.push({
        rzpRowId: row.id,
        rzpOrderId: row.rzpOrderId,
        orderId: row.orderId,
        outcome: "apply-error",
        paymentId: captured.id,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Second pass — rows already marked 'paid' but whose internal receipt is
  // missing. Both the webhook and this job flip the gateway row to 'paid'
  // BEFORE calling applyPaidPayment; if that apply crashed (or threw) the
  // row is stranded 'paid' yet the dealer was never credited and the order
  // never confirmed. The main scan (created/attempted/failed) can't see a
  // row that's already 'paid'. applyPaidPayment is idempotent, so re-running
  // it is safe.
  const orphans = await pgClient`
    SELECT rp.id::text        AS id,
           rp.razorpay_order_id AS "rzpOrderId",
           rp.order_id::text  AS "orderId",
           rp.razorpay_payment_id AS "rzpPaymentId"
      FROM razorpay_payments rp
     WHERE rp.status = 'paid'
       AND rp.razorpay_payment_id IS NOT NULL
       AND rp.created_at > now() - make_interval(hours => ${maxAgeHours})
       AND NOT EXISTS (
         SELECT 1 FROM payments p
          WHERE p.reference = rp.razorpay_payment_id AND p.mode = 'upi'
       )
     LIMIT ${limit}
  `;

  for (const row of orphans as any[]) {
    try {
      const applied = await applyPaidPayment(row.id);
      if (applied.alreadyApplied) {
        summary.alreadyApplied++;
      } else {
        summary.applied++;
      }
      summary.items.push({
        rzpRowId: row.id,
        rzpOrderId: row.rzpOrderId,
        orderId: row.orderId,
        outcome: applied.alreadyApplied ? "already-applied" : "applied",
        paymentId: row.rzpPaymentId,
        amount: applied.amount,
        detail: "paid-but-unapplied",
      });
    } catch (err) {
      summary.errors++;
      summary.items.push({
        rzpRowId: row.id,
        rzpOrderId: row.rzpOrderId,
        orderId: row.orderId,
        outcome: "apply-error",
        paymentId: row.rzpPaymentId,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Third pass — the gateway row is 'paid' AND the internal receipt exists,
  // but the ORDER never advanced: still draft/payment_required, or worse,
  // auto-discarded at window close as "unpaid". This is the HMU-2A9B failure
  // mode, and BOTH passes above are blind to it (the row isn't stuck and the
  // receipt exists). applyPaidPayment now re-runs the order confirm on its
  // already-applied path — and revives an order cancelled with the worker's
  // auto-discard reason — without ever double-booking money, so routing
  // these through it is safe and idempotent.
  const stuckOrders = await pgClient`
    SELECT rp.id::text            AS id,
           rp.razorpay_order_id   AS "rzpOrderId",
           rp.order_id::text      AS "orderId",
           rp.razorpay_payment_id AS "rzpPaymentId"
      FROM razorpay_payments rp
      JOIN orders o ON o.id = rp.order_id
     WHERE rp.status = 'paid'
       AND rp.kind = 'order_payment'
       AND rp.created_at > now() - make_interval(hours => ${maxAgeHours})
       AND (o.status IN ('draft', 'payment_required')
            OR (o.status = 'cancelled'
                AND o.cancellation_reason = ${AUTO_DISCARD_REASON}))
     LIMIT ${limit}
  `;

  for (const row of stuckOrders as any[]) {
    try {
      const applied = await applyPaidPayment(row.id);
      summary.applied++;
      summary.items.push({
        rzpRowId: row.id,
        rzpOrderId: row.rzpOrderId,
        orderId: row.orderId,
        outcome: "applied",
        paymentId: row.rzpPaymentId,
        amount: applied.amount,
        detail: "paid-but-order-stuck",
      });
    } catch (err) {
      summary.errors++;
      summary.items.push({
        rzpRowId: row.id,
        rzpOrderId: row.rzpOrderId,
        orderId: row.orderId,
        outcome: "apply-error",
        paymentId: row.rzpPaymentId,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (summary.applied > 0 || summary.errors > 0) {
    console.log(
      `[reconcile-razorpay] scanned=${summary.scanned} applied=${summary.applied} ` +
        `alreadyApplied=${summary.alreadyApplied} noCapture=${summary.noCapture} errors=${summary.errors}`
    );
  }

  return summary;
}

export async function paymentReconciliationRoutes(app: FastifyInstance) {
  // Internal, secret-guarded trigger. The worker cron POSTs here; ops can
  // also curl it to force an immediate sweep.
  app.post("/api/v1/internal/reconcile-razorpay", async (request, reply) => {
    const secret = process.env.INTERNAL_JOB_SECRET;
    if (!secret) {
      request.log.error(
        "[reconcile-razorpay] INTERNAL_JOB_SECRET is not set — the payment reconciliation safety net cannot run."
      );
      return reply
        .status(503)
        .send({ error: "INTERNAL_JOB_SECRET not configured" });
    }
    const provided = request.headers["x-internal-secret"];
    if (typeof provided !== "string" || provided !== secret) {
      return reply.status(401).send({ error: "Unauthorized" });
    }

    const q = z
      .object({
        olderThanMinutes: z.coerce.number().int().min(1).max(1440).optional(),
        maxAgeHours: z.coerce.number().int().min(1).max(8760).optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
      })
      .parse(request.query);

    const result = await reconcileStuckRazorpayPayments(q);
    return reply.send(result);
  });
}
