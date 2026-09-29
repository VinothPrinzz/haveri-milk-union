// ═══════════════════════════════════════════════════════════════════════
// apps/api/src/routes/gate-pass-sweep.ts
//
// Safety net for the counter-QR gate pass rail.
//
// A gate pass is written CONFIRMED, stock-deducted and invoiced the moment it
// is issued, before the customer has scanned anything — the QR needs a sale to
// attach to. On UPI nothing is posted to the ledger at that point either, so a
// customer who walks away without paying leaves goods off the floor with the
// money tracked precisely nowhere. The counter screen now asks the operator
// whether to cancel the pass when they close an unpaid QR, which covers the
// case where somebody is standing at the till. This covers the rest: the tab
// closed, the browser crashed, the machine was switched off.
//
// WHY THIS RAIL NEEDS ITS OWN NET. payment-reconciliation.ts — the sweep that
// recovers captured-but-unapplied Razorpay money — cannot see an UNPAID gate
// pass at all: its first pass asks the gateway for an order's attempts, and a
// gate-pass QR has no razorpay_order_id to ask about (hence the surviving
// `kind <> 'gate_pass'` filter there). Its second pass now DOES re-apply a
// gate-pass row stranded on 'paid' with no receipt. So the gap this job fills
// is the unpaid-or-unrecorded QR: it verifies at the gateway before it
// cancels anything, and a QR that turns out to have been PAID is applied here
// rather than cancelled.
//
// ORDER OF SAFETY, most important first:
//   1. Never cancel without asking Razorpay first. A pass whose capture we
//      merely failed to record is a real, paid sale, and cancelling it would
//      void an invoice and hand back stock that has already left.
//   2. If Razorpay is unreachable or unconfigured, SKIP. Doing nothing is
//      always recoverable; cancelling blind is not.
//   3. Only ever touch a pass that was never stamped with a payment reference
//      and has collected nothing. A manually keyed UPI reference (the "Enter
//      reference manually" path) stamps payment_ref at creation and is
//      therefore never a candidate.
//
// Triggered on a schedule by the worker (POST /api/v1/internal/sweep-unpaid-
// gate-passes, guarded by INTERNAL_JOB_SECRET) and safe to invoke by hand.
// Supports ?dryRun=1 to list what it would do without doing it.
// ═══════════════════════════════════════════════════════════════════════

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pgClient } from "../lib/db.js";
import {
  isRazorpayConfigured,
  fetchRazorpayQrCode,
  fetchRazorpayQrCodePayments,
} from "../lib/razorpay-client.js";
import { applyPaidGatePassPayment } from "./dealer-payments.js";
import {
  cancelDirectSale,
  DirectSaleCancelError,
} from "../lib/direct-sale-money.js";

/**
 * How long an unpaid pass is left alone. Six hours is chosen so the nightly
 * run never touches something issued that evening while a customer might still
 * be fetching their phone — those are caught by the following night's run.
 */
const DEFAULT_GRACE_HOURS = 6;
const DEFAULT_LIMIT = 100;

export const SWEEP_REASON = "Auto-cancelled: counter QR left unpaid";

interface SweepItem {
  saleId: string;
  gpNo: string | null;
  dealerName: string | null;
  grandTotal: number;
  outcome:
    | "cancelled"
    | "recovered"
    | "would-cancel"
    | "would-recover"
    | "skipped-gateway"
    | "skipped-live-qr"
    | "cancel-error";
  detail?: string;
  paymentId?: string;
}

export interface GatePassSweepSummary {
  scanned: number;
  cancelled: number;
  recovered: number;
  skipped: number;
  errors: number;
  dryRun: boolean;
  graceHours: number;
  items: SweepItem[];
}

export async function sweepUnpaidGatePasses(opts?: {
  graceHours?: number | undefined;
  limit?: number | undefined;
  dryRun?: boolean | undefined;
}): Promise<GatePassSweepSummary> {
  // Floored to a whole number: make_interval(hours => ...) takes an integer
  // and a fractional bind blows up at parse time with a bare 22P02. The HTTP
  // schema already enforces .int(), so this only guards a direct call.
  const graceHours = Math.max(1, Math.floor(opts?.graceHours ?? DEFAULT_GRACE_HOURS));
  const limit = Math.max(1, Math.floor(opts?.limit ?? DEFAULT_LIMIT));
  const dryRun = opts?.dryRun ?? false;

  // Candidates: agent gate passes on UPI, still confirmed, never stamped with
  // a reference, nothing collected through the gateway, past the grace period.
  const candidates = await pgClient`
    SELECT ds.id::text            AS "saleId",
           ds.gp_no               AS "gpNo",
           ds.grand_total::float8 AS "grandTotal",
           d.name                 AS "dealerName"
      FROM direct_sales ds
      LEFT JOIN dealers d ON d.id = ds.customer_id
     WHERE ds.customer_type = 'agent'
       AND ds.payment_mode  = 'upi'
       AND ds.status        = 'confirmed'
       AND ds.payment_ref IS NULL
       AND ds.grand_total > 0
       AND ds.created_at < now() - make_interval(hours => ${graceHours})
       AND COALESCE((
             SELECT SUM(rp.amount - rp.amount_refunded)
               FROM razorpay_payments rp
              WHERE rp.direct_sale_id = ds.id
                AND rp.kind = 'gate_pass'
                AND rp.status IN ('paid', 'refunded')
           ), 0) <= 0.001
     ORDER BY ds.created_at
     LIMIT ${limit}
  `;

  const summary: GatePassSweepSummary = {
    scanned: candidates.length,
    cancelled: 0,
    recovered: 0,
    skipped: 0,
    errors: 0,
    dryRun,
    graceHours,
    items: [],
  };
  if (candidates.length === 0) return summary;

  const gatewayUp = isRazorpayConfigured();

  for (const c of candidates as any[]) {
    const base = {
      saleId: c.saleId as string,
      gpNo: (c.gpNo ?? null) as string | null,
      dealerName: (c.dealerName ?? null) as string | null,
      grandTotal: Number(c.grandTotal),
    };

    // The QR this pass last offered, whatever state it ended in.
    const [rzp] = await pgClient`
      SELECT id::text            AS "rzpRowId",
             razorpay_qr_code_id AS "qrId",
             status::text        AS status
        FROM razorpay_payments
       WHERE direct_sale_id = ${c.saleId}::uuid
         AND kind = 'gate_pass'
       ORDER BY created_at DESC
       LIMIT 1
    `;

    // No QR was ever minted, so no money could ever have reached us for this
    // pass. Safe to cancel without consulting the gateway.
    const neverPayable = !rzp || !(rzp as any).qrId;

    if (!neverPayable && !gatewayUp) {
      // Rule 2: never cancel blind.
      summary.skipped++;
      summary.items.push({
        ...base,
        outcome: "skipped-gateway",
        detail: "Razorpay is not configured, so payment could not be ruled out",
      });
      continue;
    }

    if (!neverPayable) {
      const qrId = String((rzp as any).qrId);
      try {
        const remote = await fetchRazorpayQrCode(qrId);

        // Rule 1: money may have arrived without the webhook landing. This
        // rail has no other reconcile pass, so recover it here.
        if (remote.paymentsCountReceived > 0) {
          const payments = await fetchRazorpayQrCodePayments(qrId);
          const captured = payments.find((p) => p.status === "captured");
          if (captured && dryRun) {
            summary.items.push({
              ...base,
              outcome: "would-recover",
              paymentId: captured.id,
              detail: "QR was paid but never applied",
            });
            continue;
          }
          if (captured) {
            await pgClient`
              UPDATE razorpay_payments
                 SET status = 'paid',
                     razorpay_payment_id = ${captured.id},
                     paid_at = COALESCE(paid_at, now()),
                     updated_at = now()
               WHERE id = ${(rzp as any).rzpRowId}::uuid
                 AND status IN ('created', 'attempted', 'failed')
            `;
            await applyPaidGatePassPayment(String((rzp as any).rzpRowId));
            summary.recovered++;
            summary.items.push({
              ...base,
              outcome: "recovered",
              paymentId: captured.id,
              detail: "QR had been paid; applied instead of cancelled",
            });
            continue;
          }
        }

        // A QR still ACTIVE at the gateway is one a customer could still be
        // scanning. Leave it: the next run picks it up once it has closed.
        if (remote.status === "active") {
          summary.skipped++;
          summary.items.push({
            ...base,
            outcome: "skipped-live-qr",
            detail: "QR is still active at Razorpay",
          });
          continue;
        }
      } catch (err: any) {
        // Rule 2 again: a gateway we could not reach is not a gateway that
        // said no.
        summary.skipped++;
        summary.items.push({
          ...base,
          outcome: "skipped-gateway",
          detail: `Could not verify at Razorpay: ${String(err?.message ?? err).slice(0, 200)}`,
        });
        continue;
      }
    }

    if (dryRun) {
      summary.items.push({ ...base, outcome: "would-cancel" });
      continue;
    }

    try {
      // The canonical path: closes any live QR at Razorpay FIRST (and aborts
      // if it cannot), restores stock, reverses postings, voids the invoice.
      await cancelDirectSale(c.saleId, `${SWEEP_REASON} for ${graceHours}h`, null);
      summary.cancelled++;
      summary.items.push({ ...base, outcome: "cancelled" });
    } catch (err: any) {
      summary.errors++;
      summary.items.push({
        ...base,
        outcome: "cancel-error",
        detail:
          err instanceof DirectSaleCancelError
            ? err.message
            : String(err?.message ?? err).slice(0, 200),
      });
    }
  }

  return summary;
}

export async function gatePassSweepRoutes(app: FastifyInstance) {
  // Internal, secret-guarded trigger. The worker cron POSTs here nightly; ops
  // can also curl it, and ?dryRun=1 lists candidates without touching them.
  app.post("/api/v1/internal/sweep-unpaid-gate-passes", async (request, reply) => {
    const secret = process.env.INTERNAL_JOB_SECRET;
    if (!secret) {
      request.log.error(
        "[sweep-gate-passes] INTERNAL_JOB_SECRET is not set — unpaid counter QR passes will pile up as confirmed sales."
      );
      return reply.status(503).send({ error: "INTERNAL_JOB_SECRET not configured" });
    }
    const provided = request.headers["x-internal-secret"];
    if (typeof provided !== "string" || provided !== secret) {
      return reply.status(401).send({ error: "Unauthorized" });
    }

    const q = z
      .object({
        graceHours: z.coerce.number().int().min(1).max(720).optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
        dryRun: z.coerce.boolean().optional(),
      })
      .parse(request.query);

    const result = await sweepUnpaidGatePasses(q);

    if (result.cancelled > 0 || result.recovered > 0 || result.errors > 0) {
      request.log.warn(
        { ...result, items: undefined },
        `[sweep-gate-passes] scanned=${result.scanned} cancelled=${result.cancelled} ` +
          `recovered=${result.recovered} skipped=${result.skipped} errors=${result.errors}`
      );
    }
    return reply.send(result);
  });
}
