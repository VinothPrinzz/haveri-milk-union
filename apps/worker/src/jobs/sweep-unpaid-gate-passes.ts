// ═══════════════════════════════════════════════════════════════════════
// apps/worker/src/jobs/sweep-unpaid-gate-passes.ts
//
// Nightly trigger for the counter-QR gate pass sweep.
//
// A gate pass is confirmed, stock-deducted and invoiced the moment it is
// issued, before the customer has scanned. The counter screen asks the
// operator whether to cancel when they close an unpaid QR, but nothing
// catches the pass whose browser tab was simply closed. This does.
//
// The sweep logic lives in the API (apps/api/.../gate-pass-sweep.ts) so it can
// reuse cancelDirectSale() and applyPaidGatePassPayment() — the single source
// of truth for QR closure, stock restoration, ledger reversal and invoice
// voiding. This job is just the cron trigger, exactly like reconcile-payments.
//
// It logs LOUDLY on misconfiguration, because a silent sweep that never runs
// is indistinguishable from a sweep that found nothing.
//
// Requires env: API_INTERNAL_URL (base URL of the API) and
// INTERNAL_JOB_SECRET (shared with the API).
// ═══════════════════════════════════════════════════════════════════════

export async function processSweepUnpaidGatePasses() {
  const base = process.env.API_INTERNAL_URL || process.env.API_URL;
  const secret = process.env.INTERNAL_JOB_SECRET;

  if (!base || !secret) {
    console.error(
      "[SweepGatePasses] MISCONFIGURED — set API_INTERNAL_URL and INTERNAL_JOB_SECRET so unpaid counter QR passes get cleared. Skipping this run."
    );
    return { skipped: "misconfigured" as const };
  }

  const url = `${base.replace(/\/+$/, "")}/api/v1/internal/sweep-unpaid-gate-passes`;

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
      "[SweepGatePasses] could not reach the sweep endpoint:",
      err instanceof Error ? err.message : err
    );
    throw err; // surface as a failed cron run
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error(
      `[SweepGatePasses] sweep endpoint returned ${res.status} ${res.statusText}: ${text}`
    );
    throw new Error(`sweep HTTP ${res.status}`);
  }

  const body: any = await res.json().catch(() => ({}));
  if ((body.cancelled ?? 0) > 0 || (body.recovered ?? 0) > 0 || (body.errors ?? 0) > 0) {
    console.log(
      `[SweepGatePasses] scanned=${body.scanned} cancelled=${body.cancelled} ` +
        `recovered=${body.recovered} skipped=${body.skipped} errors=${body.errors}`
    );
    // A recovery means real money had been captured with no webhook to apply
    // it. Worth its own line: this rail has no other reconcile pass.
    for (const it of (body.items ?? []) as any[]) {
      if (it.outcome === "recovered") {
        console.warn(
          `[SweepGatePasses] RECOVERED ${it.gpNo ?? it.saleId}: Rs.${it.grandTotal} ` +
            `was paid (${it.paymentId}) but never applied — the webhook missed it.`
        );
      }
    }
  }
  return body;
}
