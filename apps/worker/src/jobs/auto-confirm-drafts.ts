// ═══════════════════════════════════════════════════════════════════════
// apps/worker/src/jobs/auto-confirm-drafts.ts
//
// Runs every 5 minutes. For each route whose ordering window has just
// closed, AUTO-PLACE today's indent for every active dealer on that
// route — driven by the dealer's standing indent, not by whether a
// draft row happens to exist yet.
//
// WHY THIS IS STANDING-INDENT-DRIVEN (and not "confirm existing drafts"):
//   The old version only confirmed orders that were already
//   status='draft'. Those rows only exist if the nightly
//   materialize-drafts job ran the night before OR the dealer opened
//   the app and edited. A dealer who has a standing indent but never
//   opens the app (and whose draft wasn't pre-materialized) had NO row,
//   so nothing got placed for them at close time. GET /drafts/:date
//   only *synthesizes* a preview — it never persists. So this job now
//   materialises-then-confirms when a row is missing.
//
// Per dealer, for today's delivery_date:
//   • Most-recent order is 'draft'        → credit-check → confirm / payment_required
//   • Most-recent order is already placed → skip (confirmed/payment_required/…)
//   • Most-recent order is 'cancelled'    → skip (respect the cancellation)
//   • No order at all + active standing    → materialise from standing → confirm
//   • No order + no standing indent        → skip (nothing to place)
//   • Dealer paused for today              → skip
//
// Confirm logic mirrors POST /drafts/:date/confirm in dealer-indents.ts
// EXACTLY, including the dealer_ledger debit — so an auto-placed order
// is identical to a manually-placed one (hits the books, gets an
// invoice, counts toward outstanding).
//
// Notes:
//   • The credit check is duplicated from apps/api/src/lib/credit-check.ts
//     because the worker is its own package. Keep the two in sync.
//   • The lookback that decides "window just closed" is generous (15 min,
//     lower-bound inclusive) so a close_time landing exactly on the 5-min
//     cron boundary is never skipped. Re-processing is safe: every write
//     is guarded on status='draft' / "no order exists", so a route seen
//     on three consecutive ticks confirms each dealer at most once.
// ═══════════════════════════════════════════════════════════════════════

import { Job } from "bullmq";
import { sql } from "../lib/db.js";
import { pushQueue as notifQueue, pdfQueue } from "../lib/queues.js";

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

function istNow(): Date {
  return new Date(Date.now() + IST_OFFSET_MS);
}
function istTodayIso(): string {
  return istNow().toISOString().slice(0, 10);
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ── Credit check (in-worker copy of apps/api/src/lib/credit-check.ts) ─
async function workerCreditCheck(
  dealerId: string,
  orderTotal: number
): Promise<{ available: number; sufficient: boolean; shortfall: number }> {
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
  const shortfall = sufficient ? 0 : round2(orderTotal - available);
  return { available: round2(available), sufficient, shortfall };
}

// ── Types ────────────────────────────────────────────────────────────

interface RouteRow {
  id: string;
  name: string;
  close_time: string; // "HH:MM:SS"
}

interface DealerRow {
  dealer_id: string;
  zone_id: string;
  dealer_name: string;
  fcm_token: string | null;
  notifications_enabled: boolean;
  order_id: string | null;
  order_status: string | null;
  grand_total: string | null; // numeric → string
  item_count: number | null;
  paused: boolean;
  has_standing: boolean;
}

interface StandingItem {
  product_id: string;
  default_qty: number;
  name: string;
  base_price: string;
  gst_percent: string;
}

// ── Main job ─────────────────────────────────────────────────────────

export async function processAutoConfirmDrafts(_job: Job) {
  const todayIso = istTodayIso();
  const nowIstTime = istNow().toISOString().slice(11, 19); // "HH:MM:SS"

  // Routes whose close_time elapsed within the last ~15 minutes.
  // Lower bound is inclusive and generous so a close_time on the cron
  // boundary (e.g. 08:00 with a */5 cron) is never missed.
  const routesWithClosedWindows: RouteRow[] = await sql`
    SELECT
      r.id::text          AS id,
      r.name              AS name,
      tw.close_time::text AS close_time
    FROM routes r
    JOIN time_windows tw ON tw.route_id = r.id
    WHERE tw.active = true
      AND tw.close_time <= ${nowIstTime}::time
      AND tw.close_time >  (${nowIstTime}::time - interval '15 minutes')
  `;

  if (routesWithClosedWindows.length === 0) {
    return { routesMatched: 0, confirmed: 0, paymentRequired: 0, materialized: 0 };
  }

  console.log(
    `[AutoConfirm] ${routesWithClosedWindows.length} route(s) just closed:`,
    routesWithClosedWindows.map((r) => `${r.name}@${r.close_time}`).join(", ")
  );

  let confirmed = 0;
  let paymentRequired = 0;
  let materialized = 0;
  let cancelledEmpty = 0;
  let skipped = 0;
  let failed = 0;

  // ── Build a draft order from the dealer's standing indent ──────────
  // Returns { orderId, grandTotal, itemCount } or null if the template
  // is empty (no active rows / all qty 0).
  async function materializeFromStanding(
    dealer: DealerRow
  ): Promise<{ orderId: string; grandTotal: number; itemCount: number } | null> {
    const items: StandingItem[] = await sql`
      SELECT
        dsi.product_id::text         AS product_id,
        dsi.default_qty              AS default_qty,
        p.name                       AS name,
        p.base_price::numeric::text  AS base_price,
        p.gst_percent::numeric::text AS gst_percent
      FROM dealer_standing_indents dsi
      JOIN products p ON p.id = dsi.product_id
                     AND p.deleted_at IS NULL
                     AND p.available = true
      WHERE dsi.dealer_id = ${dealer.dealer_id}::uuid
        AND dsi.active = true
        AND dsi.default_qty > 0
    `;
    if (items.length === 0) return null;

    let subtotal = 0;
    let totalGst = 0;
    let itemCount = 0;
    const lines = items.map((it) => {
      const price = parseFloat(it.base_price);
      const gstPct = parseFloat(it.gst_percent);
      const lineSub = price * it.default_qty;
      const lineGst = lineSub * (gstPct / 100);
      subtotal += lineSub;
      totalGst += lineGst;
      itemCount += it.default_qty;
      return {
        product_id: it.product_id,
        name: it.name,
        default_qty: it.default_qty,
        unitPrice: price.toFixed(2),
        gst_percent: gstPct.toFixed(2),
        gstAmount: lineGst.toFixed(2),
        lineTotal: (lineSub + lineGst).toFixed(2),
      };
    });
    const grandTotal = round2(subtotal + totalGst);

    const orderId = await sql.begin(async (tx) => {
      const [row] = await tx`
        INSERT INTO orders (
          dealer_id, zone_id, status, payment_mode,
          subtotal, total_gst, grand_total, item_count,
          delivery_date
        ) VALUES (
          ${dealer.dealer_id}::uuid, ${dealer.zone_id}::uuid, 'draft', 'credit',
          ${subtotal.toFixed(2)}::numeric,
          ${totalGst.toFixed(2)}::numeric,
          ${grandTotal.toFixed(2)}::numeric,
          ${itemCount},
          ${todayIso}::date
        )
        RETURNING id::text AS id
      `;
      for (const ln of lines) {
        await tx`
          INSERT INTO order_items (
            order_id, product_id, product_name, quantity,
            unit_price, gst_percent, gst_amount, line_total
          ) VALUES (
            ${row!.id}::uuid, ${ln.product_id}::uuid, ${ln.name},
            ${ln.default_qty}, ${ln.unitPrice}::numeric,
            ${ln.gst_percent}::numeric, ${ln.gstAmount}::numeric,
            ${ln.lineTotal}::numeric
          )
        `;
      }
      return row!.id;
    });

    return { orderId, grandTotal, itemCount };
  }

  // ── Confirm a draft order on credit (or flag payment_required) ─────
  // Mirrors POST /drafts/:date/confirm: writes the dealer_ledger debit
  // inside the same transaction so the books stay consistent. Returns
  // the outcome so the caller can bump counters + notify.
  async function confirmDraftOnCredit(
    dealer: DealerRow,
    orderId: string,
    grandTotal: number
  ): Promise<"confirmed" | "payment_required"> {
    const credit = await workerCreditCheck(dealer.dealer_id, grandTotal);

    if (!credit.sufficient) {
      await sql`
        UPDATE orders SET status = 'payment_required', updated_at = now()
         WHERE id = ${orderId}::uuid AND status = 'draft'
      `;
      if (dealer.notifications_enabled && dealer.fcm_token) {
        await notifQueue
          .add("payment-required", {
            event: "payment.reminder" as const,
            dealerId: dealer.dealer_id,
            orderId,
            title: "Payment required for today's indent ⚠️",
            body: `Short by ₹${credit.shortfall.toFixed(
              0
            )}. Top up credit or pay this order to confirm delivery.`,
          })
          .catch((e) =>
            console.warn(`[AutoConfirm] notif failed for ${orderId}:`, e?.message)
          );
      }
      return "payment_required";
    }

    // Sufficient credit → confirm + ledger debit, atomically.
    const applied = await sql.begin(async (tx) => {
      // Auto-confirmed at close time → zero cancel grace (window is shut).
      const upd = await tx`
        UPDATE orders
           SET status       = 'confirmed',
               payment_mode = 'credit',
               confirmed_at  = COALESCE(confirmed_at, now()),
               cancel_window_ends_at = now(),
               updated_at    = now()
         WHERE id = ${orderId}::uuid AND status = 'draft'
      `;
      // Another tick (or the dealer) already moved it on — don't double-post.
      if (upd.count === 0) return false;

      const [bal] = await tx`
        SELECT
          COALESCE(d.opening_balance, 0)
          + COALESCE((SELECT SUM(CASE WHEN dl.type = 'credit'
                                       AND COALESCE(dl.voucher_type,'') <> 'Opening'
                                      THEN dl.amount ELSE 0 END)
                        FROM dealer_ledger dl WHERE dl.dealer_id = d.id), 0)
          - COALESCE((SELECT SUM(CASE WHEN dl.type = 'debit'
                                       AND COALESCE(dl.voucher_type,'') <> 'Opening'
                                      THEN dl.amount ELSE 0 END)
                        FROM dealer_ledger dl WHERE dl.dealer_id = d.id), 0)
          AS bal
        FROM dealers d WHERE d.id = ${dealer.dealer_id}::uuid
      `;
      const balanceAfter = parseFloat(bal!.bal) - grandTotal;

      await tx`
        INSERT INTO dealer_ledger
          (dealer_id, type, amount,
           reference_id, reference_type,
           voucher_type, voucher_date,
           description, balance_after)
        VALUES
          (${dealer.dealer_id}::uuid, 'debit', ${grandTotal.toFixed(2)}::numeric,
           ${orderId}::uuid, 'order',
           'Invoice', now()::date,
           ${"Auto-confirmed standing-indent order " + orderId},
           ${balanceAfter.toFixed(2)}::numeric)
      `;
      return true;
    });

    if (!applied) return "confirmed"; // already handled by a prior tick

    await pdfQueue
      .add(`invoice-${orderId.slice(0, 8)}`, { orderId }, {
        removeOnComplete: 100,
        removeOnFail: 500,
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
      })
      .catch((e) =>
        console.warn(`[AutoConfirm] invoice enqueue failed for ${orderId}:`, e?.message)
      );

    if (dealer.notifications_enabled && dealer.fcm_token) {
      await notifQueue
        .add("indent-confirmed", {
          event: "order.confirmed" as const,
          dealerId: dealer.dealer_id,
          orderId,
          title: "Indent confirmed ✓",
          body: `Today's indent · ₹${grandTotal.toFixed(0)}. Out for delivery soon.`,
        })
        .catch((e) =>
          console.warn(`[AutoConfirm] notif failed for ${orderId}:`, e?.message)
        );
    }
    return "confirmed";
  }

  // ── Per-route → per-dealer ─────────────────────────────────────────
  for (const route of routesWithClosedWindows) {
    // Every active dealer on this route, with their most-recent order
    // for today (any status), pause flag, and whether they have an
    // active standing indent. One pass, no N+1 for the decision.
    const dealers: DealerRow[] = await sql`
      SELECT
        d.id::text              AS dealer_id,
        d.zone_id::text         AS zone_id,
        d.name                  AS dealer_name,
        d.fcm_token             AS fcm_token,
        d.notifications_enabled AS notifications_enabled,
        o.id::text              AS order_id,
        o.status::text          AS order_status,
        o.grand_total::numeric::text AS grand_total,
        o.item_count            AS item_count,
        (pause.dealer_id IS NOT NULL) AS paused,
        EXISTS (
          SELECT 1 FROM dealer_standing_indents dsi
           WHERE dsi.dealer_id = d.id
             AND dsi.active = true
             AND dsi.default_qty > 0
        ) AS has_standing
      FROM dealers d
      LEFT JOIN LATERAL (
        SELECT o2.id, o2.status, o2.grand_total, o2.item_count
          FROM orders o2
         WHERE o2.dealer_id = d.id
           AND o2.delivery_date = ${todayIso}::date
         ORDER BY o2.created_at DESC
         LIMIT 1
      ) o ON true
      LEFT JOIN LATERAL (
        SELECT dip.dealer_id
          FROM dealer_indent_pauses dip
         WHERE dip.dealer_id = d.id
           AND ${todayIso}::date BETWEEN dip.from_date AND dip.to_date
         LIMIT 1
      ) pause ON true
      WHERE d.route_id = ${route.id}::uuid
        AND d.active = true
        AND d.deleted_at IS NULL
    `;

    if (dealers.length === 0) continue;

    for (const dealer of dealers) {
      try {
        if (dealer.paused) {
          skipped++;
          continue;
        }

        const status = dealer.order_status;

        // ── Existing draft → confirm (or cancel if empty) ────────────
        if (status === "draft" && dealer.order_id) {
          const grandTotal = parseFloat(dealer.grand_total ?? "0");
          if ((dealer.item_count ?? 0) === 0 || grandTotal === 0) {
            await sql`
              UPDATE orders
                 SET status = 'cancelled',
                     cancellation_reason = 'Empty draft at close time',
                     cancelled_at = now(),
                     updated_at = now()
               WHERE id = ${dealer.order_id}::uuid AND status = 'draft'
            `;
            cancelledEmpty++;
            continue;
          }
          const outcome = await confirmDraftOnCredit(
            dealer,
            dealer.order_id,
            grandTotal
          );
          outcome === "confirmed" ? confirmed++ : paymentRequired++;
          continue;
        }

        // ── Already placed / cancelled → leave it alone ──────────────
        if (status !== null) {
          skipped++;
          continue;
        }

        // ── No order at all → materialise from standing, then confirm ─
        if (!dealer.has_standing) {
          skipped++;
          continue;
        }
        const built = await materializeFromStanding(dealer);
        if (!built) {
          skipped++;
          continue;
        }
        materialized++;
        const outcome = await confirmDraftOnCredit(
          dealer,
          built.orderId,
          built.grandTotal
        );
        outcome === "confirmed" ? confirmed++ : paymentRequired++;
      } catch (err: any) {
        failed++;
        console.error(
          `[AutoConfirm] dealer=${dealer.dealer_id} (${dealer.dealer_name}) failed:`,
          err?.message ?? err
        );
        // One dealer's failure must not stop the batch.
      }
    }
  }

  // Shared queues are long-lived — closed once on worker shutdown.

  const summary = {
    routesMatched: routesWithClosedWindows.length,
    confirmed,
    paymentRequired,
    materialized,
    cancelledEmpty,
    skipped,
    failed,
  };
  console.log(`[AutoConfirm] Done:`, summary);
  return summary;
}
