// ═══════════════════════════════════════════════════════════════════════
// apps/worker/src/jobs/materialize-drafts.ts
//
// Phase 3 — nightly job that pre-creates tomorrow's draft order for
// every active dealer from their standing-indent template.
//
// Schedule: 04:00 IST daily (= 22:30 UTC previous day; see index.ts).
//
// Why nightly + lazy synthesis?
//   GET /api/v1/dealer/drafts/:date already synthesizes a draft on
//   the fly if no row exists yet — so technically this worker isn't
//   *required* for correctness. But:
//
//     • Push notifications need an order row to reference ("indent
//       for tomorrow is ready · ₹3,420 · 14 items"). Without a row,
//       the notif text would be vague.
//     • Reports and dashboards want to count tomorrow's expected
//       volume the moment business hours start, not when individual
//       dealers happen to open the app.
//     • The closing-time auto-confirm job (auto-confirm-drafts.ts)
//       looks for orders with status='draft' — so a draft row must
//       exist for auto-confirm to fire.
//
// Idempotency:
//   The unique index `uq_orders_dealer_delivery_draft` (from
//   migration 0031) prevents duplicate drafts. The job also
//   explicitly checks before insert. Re-running this job is safe.
//
// Pause windows:
//   Dealers with an active pause spanning tomorrow's date are skipped.
//   When the pause ends, the next nightly run picks them up again.
//
// Empty templates:
//   Dealers with no active standing-indent rows (or all default_qty=0)
//   are skipped — no point creating an empty draft. They can still
//   add items manually via the app.
// ═══════════════════════════════════════════════════════════════════════

import { Job } from "bullmq";
import { sql } from "../lib/db.js";
import { pushQueue as notifQueue } from "../lib/queues.js";

// IST = UTC+5:30, no DST.
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

function tomorrowIstIso(): string {
  const nowIst = new Date(Date.now() + IST_OFFSET_MS + 86_400_000);
  return nowIst.toISOString().slice(0, 10);
}

interface DealerRow {
  id: string;
  zone_id: string;
  name: string;
  fcm_token: string | null;
  notifications_enabled: boolean;
}

interface StandingItem {
  product_id: string;
  default_qty: number;
  name: string;
  base_price: string; // numeric → string from pg driver
  gst_percent: string;
}

export async function processMaterializeDrafts(_job: Job) {
  const deliveryDate = tomorrowIstIso();
  console.log(`[Materialize] Building drafts for ${deliveryDate}`);

  const dealers: DealerRow[] = await sql`
    SELECT
      d.id::text         AS id,
      d.zone_id::text    AS zone_id,
      d.name             AS name,
      d.fcm_token        AS fcm_token,
      d.notifications_enabled AS notifications_enabled
    FROM dealers d
    WHERE d.active = true
      AND d.deleted_at IS NULL
  `;

  let created = 0;
  let skippedPaused = 0;
  let skippedExisting = 0;
  let skippedEmpty = 0;
  let failed = 0;

  for (const dealer of dealers) {
    try {
      // ── 1. Skip if paused ────────────────────────────────────
      const [paused] = await sql`
        SELECT 1 FROM dealer_indent_pauses
         WHERE dealer_id = ${dealer.id}::uuid
           AND ${deliveryDate}::date BETWEEN from_date AND to_date
         LIMIT 1
      `;
      if (paused) {
        skippedPaused++;
        continue;
      }

      // ── 2. Skip if a draft/pending already exists for this date ──
      const [existing] = await sql`
        SELECT 1 FROM orders
         WHERE dealer_id = ${dealer.id}::uuid
           AND delivery_date = ${deliveryDate}::date
           AND status IN ('draft', 'pending', 'payment_required', 'confirmed')
         LIMIT 1
      `;
      if (existing) {
        skippedExisting++;
        continue;
      }

      // ── 3. Fetch the dealer's standing-indent items ──────────
      const items: StandingItem[] = await sql`
        SELECT
          dsi.product_id::text        AS product_id,
          dsi.default_qty             AS default_qty,
          p.name                      AS name,
          p.base_price::numeric::text AS base_price,
          p.gst_percent::numeric::text AS gst_percent
        FROM dealer_standing_indents dsi
        JOIN products p ON p.id = dsi.product_id
                       AND p.deleted_at IS NULL
                       AND p.available = true
        WHERE dsi.dealer_id = ${dealer.id}::uuid
          AND dsi.active = true
          AND dsi.default_qty > 0
      `;

      if (items.length === 0) {
        skippedEmpty++;
        continue;
      }

      // ── 4. Compute totals ───────────────────────────────────
      let subtotal = 0;
      let totalGst = 0;
      let itemCount = 0;
      const lines = items.map((it) => {
        const price = parseFloat(it.base_price);
        const gstPct = parseFloat(it.gst_percent);
        const lineSub = price * it.default_qty;
        const lineGst = lineSub * (gstPct / 100);
        const lineTotal = lineSub + lineGst;
        subtotal += lineSub;
        totalGst += lineGst;
        itemCount += it.default_qty;
        return {
          ...it,
          unitPrice: price.toFixed(2),
          gstAmount: lineGst.toFixed(2),
          lineTotal: lineTotal.toFixed(2),
        };
      });
      const grandTotal = Math.round((subtotal + totalGst) * 100) / 100;

      // ── 5. Insert order + items atomically ───────────────────
      const orderId = await sql.begin(async (tx) => {
        const [row] = await tx`
          INSERT INTO orders (
            dealer_id, zone_id, status, payment_mode,
            subtotal, total_gst, grand_total, item_count,
            delivery_date
          ) VALUES (
            ${dealer.id}::uuid, ${dealer.zone_id}::uuid, 'draft', 'credit',
            ${subtotal.toFixed(2)}::numeric,
            ${totalGst.toFixed(2)}::numeric,
            ${grandTotal.toFixed(2)}::numeric,
            ${itemCount},
            ${deliveryDate}::date
          )
          RETURNING id::text AS id
        `;

        for (const ln of lines) {
          await tx`
            INSERT INTO order_items (
              order_id, product_id, product_name, quantity,
              unit_price, gst_percent, gst_amount, line_total
            ) VALUES (
              ${row.id}::uuid, ${ln.product_id}::uuid, ${ln.name},
              ${ln.default_qty}, ${ln.unitPrice}::numeric,
              ${ln.gst_percent}::numeric, ${ln.gstAmount}::numeric,
              ${ln.lineTotal}::numeric
            )
          `;
        }
        return row.id;
      });

      created++;

      // ── 6. Push notification (best-effort, doesn't block) ────
      if (dealer.notifications_enabled && dealer.fcm_token) {
        await notifQueue
          .add("indent-ready", {
            event: "custom" as const,
            dealerId: dealer.id,
            orderId,
            title: "Tomorrow's indent is ready 📋",
            body: `${itemCount} items · ₹${grandTotal.toFixed(0)}. Tap to review or edit.`,
          })
          .catch((e) =>
            console.warn(`[Materialize] notif enqueue failed for dealer ${dealer.id}:`, e?.message)
          );
      }
    } catch (err: any) {
      failed++;
      console.error(
        `[Materialize] dealer=${dealer.id} (${dealer.name}) failed:`,
        err?.message ?? err
      );
      // Continue with next dealer — one failure shouldn't stop the batch
    }
  }

  // Shared queue is long-lived — closed once on worker shutdown.

  // ── Employee standing indents (subsidized, no app / no FCM) ─────────
  const employeeSummary = await materializeEmployeeDrafts(deliveryDate);

  const summary = {
    deliveryDate,
    totalDealers: dealers.length,
    created,
    skippedPaused,
    skippedExisting,
    skippedEmpty,
    failed,
    employees: employeeSummary,
  };
  console.log(`[Materialize] Done:`, summary);
  return summary;
}

// ═══════════════════════════════════════════════════════════════════════
// Employee pass — the employee mirror of the dealer loop above.
//
// Employees have no app login, so there's no FCM / push. Indents are priced
// at the employee-subsidy rate (employee_subsidy_rules): only products with
// an active rule are included, at base_price × (1 − subsidy%) + GST.
// Idempotent: skips any employee that already has a non-cancelled
// employee_order for the date.
// ═══════════════════════════════════════════════════════════════════════

interface EmployeeStandingItem {
  product_id: string;
  default_qty: number;
  name: string;
  base_price: string;
  gst_percent: string;
  subsidy_percent: string;
}

async function materializeEmployeeDrafts(deliveryDate: string) {
  const employees: { id: string; route_id: string | null; name: string }[] = await sql`
    SELECT e.id::text AS id, e.route_id::text AS route_id, e.name AS name
      FROM employees e
     WHERE e.active = true AND e.deleted_at IS NULL
  `;

  let created = 0;
  let skippedExisting = 0;
  let skippedEmpty = 0;
  let failed = 0;

  for (const emp of employees) {
    try {
      // Skip if a non-cancelled employee_order already exists for this date.
      const [existing] = await sql`
        SELECT 1 FROM employee_orders
         WHERE employee_id = ${emp.id}::uuid
           AND delivery_date = ${deliveryDate}::date
           AND status <> 'cancelled'
         LIMIT 1
      `;
      if (existing) {
        skippedExisting++;
        continue;
      }

      const items: EmployeeStandingItem[] = await sql`
        SELECT
          esi.product_id::text         AS product_id,
          esi.default_qty              AS default_qty,
          p.name                       AS name,
          p.base_price::numeric::text  AS base_price,
          p.gst_percent::numeric::text AS gst_percent,
          r.subsidy_percent::numeric::text AS subsidy_percent
        FROM employee_standing_indents esi
        JOIN products p ON p.id = esi.product_id
                       AND p.deleted_at IS NULL
                       AND p.available = true
        JOIN employee_subsidy_rules r ON r.product_id = esi.product_id AND r.active = true
        WHERE esi.employee_id = ${emp.id}::uuid
          AND esi.active = true
          AND esi.default_qty > 0
      `;
      if (items.length === 0) {
        skippedEmpty++;
        continue;
      }

      let subtotal = 0;
      let totalGst = 0;
      let itemCount = 0;
      const lines = items.map((it) => {
        const mrp = parseFloat(it.base_price);
        const subsidyPct = parseFloat(it.subsidy_percent);
        const gstPct = parseFloat(it.gst_percent);
        const unitPrice = Math.round(mrp * (1 - subsidyPct / 100) * 100) / 100;
        const lineSub = unitPrice * it.default_qty;
        const lineGst = lineSub * (gstPct / 100);
        subtotal += lineSub;
        totalGst += lineGst;
        itemCount += it.default_qty;
        return {
          product_id: it.product_id,
          name: it.name,
          default_qty: it.default_qty,
          unitPrice: unitPrice.toFixed(2),
          gst_percent: gstPct.toFixed(2),
          gstAmount: lineGst.toFixed(2),
          lineTotal: (lineSub + lineGst).toFixed(2),
          subsidy_percent: subsidyPct.toFixed(2),
          mrp_reference: mrp.toFixed(2),
        };
      });
      const grandTotal = Math.round((subtotal + totalGst) * 100) / 100;

      await sql.begin(async (tx) => {
        const [row] = await tx`
          INSERT INTO employee_orders (
            employee_id, route_id, status, payment_mode,
            subtotal, total_gst, grand_total, item_count, delivery_date
          ) VALUES (
            ${emp.id}::uuid, ${emp.route_id}::uuid,
            'draft', 'credit',
            ${subtotal.toFixed(2)}::numeric,
            ${totalGst.toFixed(2)}::numeric,
            ${grandTotal.toFixed(2)}::numeric,
            ${itemCount},
            ${deliveryDate}::date
          )
          RETURNING id::text AS id
        `;
        for (const ln of lines) {
          await tx`
            INSERT INTO employee_order_items (
              employee_order_id, product_id, product_name, quantity,
              unit_price, gst_percent, gst_amount, line_total,
              subsidy_percent, mrp_reference
            ) VALUES (
              ${row!.id}::uuid, ${ln.product_id}::uuid, ${ln.name},
              ${ln.default_qty}, ${ln.unitPrice}::numeric,
              ${ln.gst_percent}::numeric, ${ln.gstAmount}::numeric,
              ${ln.lineTotal}::numeric, ${ln.subsidy_percent}::numeric,
              ${ln.mrp_reference}::numeric
            )
          `;
        }
      });
      created++;
    } catch (err: any) {
      failed++;
      console.error(
        `[Materialize] employee=${emp.id} (${emp.name}) failed:`,
        err?.message ?? err
      );
    }
  }

  const summary = { totalEmployees: employees.length, created, skippedExisting, skippedEmpty, failed };
  console.log(`[Materialize] Employee pass done:`, summary);
  return summary;
}