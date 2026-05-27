// ═══════════════════════════════════════════════════════════════════════
// apps/worker/src/jobs/auto-confirm-drafts.ts
//
// Phase 3 — runs every 5 minutes during typical window hours. For each
// zone whose close_time has just elapsed (within the last 5 min), find
// all draft orders for today's delivery_date in that zone and try to
// confirm them.
//
// Confirm logic (mirrors POST /drafts/:date/confirm in dealer-indents.ts):
//   • Run a credit check against the dealer's outstanding balance.
//   • Sufficient → orders.status = 'confirmed' (confirmed_at = now())
//   • Insufficient → orders.status = 'payment_required'
//                    + push notification with shortfall + top-up link
//
// Notes:
//   • Credit check is duplicated from apps/api/src/lib/credit-check.ts
//     because the worker is its own package. The two implementations
//     MUST stay in sync — when one changes the other should too. If
//     this becomes a pattern, lift it to a packages/shared lib.
//   • The "5-minute lookback" tolerance handles cases where the
//     cron is delayed (Redis hiccup, worker restart). Zones whose
//     close_time was 8 minutes ago will be processed by the previous
//     cron tick; this tick only handles 0-5 min ago.
//   • Window-state transitions on the frontend are independent of
//     this job — the mobile app already shows "window closed" based
//     on its own time check against close_time.
//
// Schedule pattern: every 5 min, all hours. The job is cheap when
// nothing matches (one SELECT, returns 0 rows, done). Filtering
// to "window hours only" inside the cron string would save calls
// but complicates timezone math.
// ═══════════════════════════════════════════════════════════════════════

import { Job, Queue } from "bullmq";
import { sql } from "../lib/db.js";
import { redis } from "../lib/redis.js";

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

function istNow(): Date {
  return new Date(Date.now() + IST_OFFSET_MS);
}
function istTodayIso(): string {
  return istNow().toISOString().slice(0, 10);
}

// ── Credit check (in-worker copy) ───────────────────────────────────
//
// Returns { available, sufficient, shortfall } given a dealer id and
// an order total. Outstanding = sum of credit-mode orders not in
// (cancelled, delivered, draft, payment_required).

async function workerCreditCheck(
  dealerId: string,
  orderTotal: number
): Promise<{
  creditLimit: number;
  outstanding: number;
  available: number;
  sufficient: boolean;
  shortfall: number;
}> {
  const [row] = await sql`
    SELECT
      COALESCE(d.credit_limit, 0)::numeric AS credit_limit,
      COALESCE((
        SELECT SUM(o.grand_total) FROM orders o
         WHERE o.dealer_id = d.id
           AND o.payment_mode = 'credit'
           AND o.status NOT IN ('cancelled', 'delivered',
                                'draft', 'payment_required')
      ), 0)::numeric AS outstanding
    FROM dealers d
    WHERE d.id = ${dealerId}::uuid
      AND d.deleted_at IS NULL
  `;
  if (!row) throw new Error(`Dealer ${dealerId} not found`);
  const creditLimit = parseFloat(row.credit_limit);
  const outstanding = parseFloat(row.outstanding);
  const available = Math.max(0, creditLimit - outstanding);
  const sufficient = orderTotal <= available;
  const shortfall = sufficient ? 0 : Math.round((orderTotal - available) * 100) / 100;
  return {
    creditLimit: round2(creditLimit),
    outstanding: round2(outstanding),
    available: round2(available),
    sufficient,
    shortfall,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ── Main job ────────────────────────────────────────────────────────

interface RouteRow {
  id: string;
  name: string;
  close_time: string; // "HH:MM:SS"
}

interface DraftRow {
  id: string;
  dealer_id: string;
  grand_total: string;
  item_count: number;
  fcm_token: string | null;
  notifications_enabled: boolean;
  dealer_name: string;
}

export async function processAutoConfirmDrafts(_job: Job) {
  const todayIso = istTodayIso();
  const nowIstTime = istNow().toISOString().slice(11, 19); // "HH:MM:SS"

  // Find routes whose close_time elapsed within the last ~5 minutes.
  // Per-route time windows are keyed by time_windows.route_id (migration 0023).
  const routesWithClosedWindows: RouteRow[] = await sql`
    SELECT
      r.id::text          AS id,
      r.name              AS name,
      tw.close_time::text AS close_time
    FROM routes r
    JOIN time_windows tw ON tw.route_id = r.id
    WHERE tw.close_time <= ${nowIstTime}::time
      AND tw.close_time >  (${nowIstTime}::time - interval '5 minutes')
  `;

  if (routesWithClosedWindows.length === 0) {
    // Quiet exit during off-hours — return cleanly, don't log per-tick.
    return { processed: 0, confirmed: 0, paymentRequired: 0, skippedNoDrafts: 0 };
  }

  console.log(
    `[AutoConfirm] ${routesWithClosedWindows.length} route(s) with windows just closed:`,
    routesWithClosedWindows.map((r) => `${r.name}@${r.close_time}`).join(", ")
  );

  let confirmed = 0;
  let paymentRequired = 0;
  let failed = 0;
  let totalDrafts = 0;

  const notifQueue = new Queue("push-notifications", { connection: redis });

  for (const route of routesWithClosedWindows) {
    // Drafts are keyed by dealer's route_id (dealers.route_id = route.id).
    // auto-confirmed orders get cancel_window_ends_at = confirmed_at (zero grace),
    // since the confirmed_at = closeTime, LEAST yields closeTime itself.
    const drafts: DraftRow[] = await sql`
      SELECT
        o.id::text                  AS id,
        o.dealer_id::text           AS dealer_id,
        o.grand_total::numeric::text AS grand_total,
        o.item_count                AS item_count,
        d.fcm_token                 AS fcm_token,
        d.notifications_enabled     AS notifications_enabled,
        d.name                      AS dealer_name
      FROM orders o
      JOIN dealers d ON d.id = o.dealer_id
      WHERE d.route_id = ${route.id}::uuid
        AND o.delivery_date = ${todayIso}::date
        AND o.status = 'draft'
    `;

    if (drafts.length === 0) continue;
    totalDrafts += drafts.length;
    console.log(`[AutoConfirm]   route=${route.name}: ${drafts.length} drafts to process`);

    for (const draft of drafts) {
      try {
        const grandTotal = parseFloat(draft.grand_total);

        // Empty drafts can happen if a dealer deleted all items but
        // didn't formally cancel. Mark as cancelled to keep the
        // status set clean — these aren't payment_required candidates.
        if (draft.item_count === 0 || grandTotal === 0) {
          await sql`
            UPDATE orders
               SET status = 'cancelled',
                   cancellation_reason = 'Empty draft at close time',
                   cancelled_at = now(),
                   updated_at = now()
             WHERE id = ${draft.id}::uuid AND status = 'draft'
          `;
          continue;
        }

        const credit = await workerCreditCheck(draft.dealer_id, grandTotal);

        if (credit.sufficient) {
          // Auto-confirmed at close time → cancel_window_ends_at = close_time
          // (LEAST of now+30min and close_time, but confirmed_at IS close_time,
          // so LEAST always yields close_time → zero grace, which is correct).
          await sql`
            UPDATE orders
               SET status = 'confirmed',
                   confirmed_at = COALESCE(confirmed_at, now()),
                   cancel_window_ends_at = now(),
                   updated_at = now()
             WHERE id = ${draft.id}::uuid AND status = 'draft'
          `;
          confirmed++;

          if (draft.notifications_enabled && draft.fcm_token) {
            await notifQueue
              .add("indent-confirmed", {
                event: "order.confirmed" as const,
                dealerId: draft.dealer_id,
                orderId: draft.id,
                title: "Indent confirmed ✓",
                body: `Today's ${draft.item_count} items · ₹${grandTotal.toFixed(
                  0
                )}. Out for delivery soon.`,
              })
              .catch((e) =>
                console.warn(`[AutoConfirm] notif failed for ${draft.id}:`, e?.message)
              );
          }
        } else {
          await sql`
            UPDATE orders
               SET status = 'payment_required',
                   updated_at = now()
             WHERE id = ${draft.id}::uuid AND status = 'draft'
          `;
          paymentRequired++;

          if (draft.notifications_enabled && draft.fcm_token) {
            await notifQueue
              .add("payment-required", {
                event: "payment.reminder" as const,
                dealerId: draft.dealer_id,
                orderId: draft.id,
                title: "Payment required for today's indent ⚠️",
                body: `Short by ₹${credit.shortfall.toFixed(
                  0
                )}. Top up credit or pay this order to confirm delivery.`,
              })
              .catch((e) =>
                console.warn(`[AutoConfirm] notif failed for ${draft.id}:`, e?.message)
              );
          }
        }
      } catch (err: any) {
        failed++;
        console.error(
          `[AutoConfirm] order=${draft.id} dealer=${draft.dealer_id} failed:`,
          err?.message ?? err
        );
        // Don't break the batch on one failure
      }
    }
  }

  await notifQueue.close();

  const summary = {
    routesMatched: routesWithClosedWindows.length,
    totalDrafts,
    confirmed,
    paymentRequired,
    failed,
  };
  console.log(`[AutoConfirm] Done:`, summary);
  return summary;
}