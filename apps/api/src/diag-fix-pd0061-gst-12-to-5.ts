// ═══════════════════════════════════════════════════════════════════════
// diag-fix-pd0061-gst-12-to-5.ts
//
// WRITES (with dry run). Corrects the GST rate on KODUBALE 30GM 10 PACK
// (PD0061) from 12% to 5% across ALL history.
//
// THE PROBLEM. The GST Statement showed PD0061 at 12% for the whole period
// from 1 July. 5% is the correct rate. products.gst_percent was already
// fixed to 5.00 on 2026-08-11 (base_price recomputed to 79.333, dealer_price
// held at 83.30), but that only affects NEW lines: the GST Statement
// (routes/sales-reports.ts) reads the per-line SNAPSHOT
//
//     oi.gst_percent, oi.unit_price, oi.gst_amount, oi.line_total
//
// which every write path stamps at line-write time. 91 order_items rows
// still carry gst_percent 12.00 / unit_price 74.370 (= 83.30 / 1.12).
//
// THE REPAIR, as directed: the DEALER'S BILL DOES NOT CHANGE. line_total —
// the money actually billed and, for 69 of these orders, already collected
// over UPI — is never written. Only the split between taxable value and tax
// moves, exactly as the master edit did (dealer_price held, base_price
// recomputed):
//
//   qty 1 line, before:  unit 74.370  taxable 74.37  GST@12% 8.92  total 83.29
//   qty 1 line, after:   unit 79.330  taxable 79.33  GST@5%  3.96  total 83.29
//                                                                  ^^^^^ same
//
// A UNIFORM unit price of 79.33 (2dp) is used so every reprinted invoice
// shows the same rate, and the tax takes the remainder, so
// taxable + gst = line_total holds EXACTLY on every line. The implied rate
// then lands within a hair of 5% (4.99%-5.01%); anything outside 4.95%-5.05%
// aborts the run.
//
// ORDER HEADERS ARE ADJUSTED BY DELTA, NEVER RECOMPUTED. 60 of these 91
// orders already carry a +/- 0.03 round-then-sum drift between grand_total
// and SUM(line_total) — a pre-existing artefact unrelated to this fix.
// Recomputing headers from the lines would silently move grand_total on
// orders that are already paid. So:
//
//     subtotal  -= delta_gst      (taxable rises by what tax falls)
//     total_gst += delta_gst
//     grand_total    NEVER WRITTEN
//
// INVOICES. After the transaction commits, every affected order is put
// through reissueInvoiceIfExists() (lib/invoice-pdf.ts) — re-renders the PDF
// at 5%, re-uploads to the same R2 key and re-upserts the invoice totals.
// The ON CONFLICT clause deliberately preserves invoice_number and
// invoice_date (the legal date of issue). 69 of the 91 orders have one.
//
// NOT IN SCOPE: PD0027 ALMOND MILK CHOCO 18GM has 3 lines at 5% against an
// 18% master — the opposite direction, still awaiting the client's answer on
// which is right. This script touches PD0061 only.
//
// USAGE (from apps/api):
//   npx tsx src/diag-fix-pd0061-gst-12-to-5.ts                  <- dry run
//   npx tsx src/diag-fix-pd0061-gst-12-to-5.ts --apply          <- commit
//   npx tsx src/diag-fix-pd0061-gst-12-to-5.ts --invoices-only  <- reissue only
// ═══════════════════════════════════════════════════════════════════════

import { pgClient } from "./lib/db.js";
import { reissueInvoiceIfExists } from "./lib/invoice-pdf.js";

const APPLY = process.argv.includes("--apply");
const INVOICES_ONLY = process.argv.includes("--invoices-only");

const CODE = "PD0061";
const OLD_PCT = "12.00";
const NEW_PCT = 5;
/** New uniform NET unit price, in paise. 79.33 = 83.30 / 1.05 at 2dp. */
const NEW_UNIT_PAISE = 7933;
/** Abort if any line's implied rate falls outside this band. */
const RATE_MIN = 4.95;
const RATE_MAX = 5.05;

/** "83.29" -> 8329. Money is compared and summed in integer paise only. */
const paise = (v: string | number | null | undefined): number =>
  Math.round(parseFloat(String(v ?? "0")) * 100);
const rupees = (p: number): string => (p / 100).toFixed(2);

interface Line {
  id: string;
  orderId: string;
  deliveryDate: string;
  status: string;
  quantity: number;
  oldUnitPrice: string;
  oldGstPercent: string;
  oldGstPaise: number;
  lineTotalPaise: number;
  newTaxablePaise: number;
  newGstPaise: number;
  impliedRate: number;
}

async function main() {
  console.log(
    INVOICES_ONLY
      ? "MODE: INVOICES ONLY (reissue, no line/header writes)\n"
      : APPLY
        ? "MODE: APPLY (writing)\n"
        : "MODE: DRY RUN (no writes)\n"
  );

  // ── The product ────────────────────────────────────────────────────
  const [prod] = (await pgClient`
    SELECT id::text AS id, code, name, gst_percent::text AS gst_percent,
           base_price::text AS base_price, dealer_price::text AS dealer_price
      FROM products WHERE code = ${CODE} AND deleted_at IS NULL
  `) as any[];
  if (!prod) throw new Error(`${CODE} not found`);
  console.log(
    `Product  ${prod.code}  ${prod.name}\n` +
      `         master gst ${prod.gst_percent}%  base ${prod.base_price}  dealer ${prod.dealer_price}\n`
  );
  if (parseFloat(prod.gst_percent) !== NEW_PCT) {
    throw new Error(
      `master gst_percent is ${prod.gst_percent}, expected ${NEW_PCT} — ` +
        `fix the product master first, this script only repairs history`
    );
  }

  // ── The lines still stamped at the old rate ────────────────────────
  const raw = (await pgClient`
    SELECT oi.id::text          AS id,
           o.id::text           AS order_id,
           o.delivery_date::text AS delivery_date,
           o.status             AS status,
           oi.quantity          AS quantity,
           oi.unit_price::text  AS unit_price,
           oi.gst_percent::text AS gst_percent,
           oi.gst_amount::text  AS gst_amount,
           oi.line_total::text  AS line_total
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
     WHERE oi.product_id = ${prod.id}::uuid
       AND oi.gst_percent = ${OLD_PCT}::numeric
     ORDER BY o.delivery_date, oi.id
  `) as any[];

  if (raw.length === 0) {
    console.log(`No lines left at ${OLD_PCT}% — nothing to repair.`);
    if (!INVOICES_ONLY) return;
  }

  const lines: Line[] = raw.map((r) => {
    const qty = Number(r.quantity);
    const lineTotalPaise = paise(r.line_total);
    const newTaxablePaise = NEW_UNIT_PAISE * qty;
    const newGstPaise = lineTotalPaise - newTaxablePaise;
    return {
      id: r.id,
      orderId: r.order_id,
      deliveryDate: r.delivery_date,
      status: r.status,
      quantity: qty,
      oldUnitPrice: r.unit_price,
      oldGstPercent: r.gst_percent,
      oldGstPaise: paise(r.gst_amount),
      lineTotalPaise,
      newTaxablePaise,
      newGstPaise,
      impliedRate: (newGstPaise / newTaxablePaise) * 100,
    };
  });

  // ── Guard: every line must land within a hair of 5% ────────────────
  const outOfBand = lines.filter(
    (l) => l.impliedRate < RATE_MIN || l.impliedRate > RATE_MAX
  );
  if (outOfBand.length > 0) {
    console.error(
      `\nABORT: ${outOfBand.length} line(s) fall outside ${RATE_MIN}%-${RATE_MAX}% ` +
        `at a uniform unit price of ${rupees(NEW_UNIT_PAISE)}:`
    );
    for (const l of outOfBand.slice(0, 10)) {
      console.error(
        `  qty ${l.quantity}  line_total ${rupees(l.lineTotalPaise)} ` +
          `-> taxable ${rupees(l.newTaxablePaise)} gst ${rupees(l.newGstPaise)} ` +
          `= ${l.impliedRate.toFixed(3)}%`
      );
    }
    throw new Error("implied rate out of band — refusing to write");
  }

  // ── What it looks like, by quantity ────────────────────────────────
  const byQty = new Map<number, { n: number; rate: number }>();
  for (const l of lines) {
    const e = byQty.get(l.quantity) ?? { n: 0, rate: l.impliedRate };
    e.n += 1;
    byQty.set(l.quantity, e);
  }
  console.log(`Lines at ${OLD_PCT}%: ${lines.length}   (one per order)\n`);
  console.log("  qty  lines   line_total        taxable      gst     implied");
  for (const [qty, e] of [...byQty.entries()].sort((a, b) => a[0] - b[0])) {
    const sample = lines.find((l) => l.quantity === qty)!;
    console.log(
      `  ${String(qty).padStart(3)}  ${String(e.n).padStart(5)}   ` +
        `${rupees(sample.lineTotalPaise).padStart(10)}   ` +
        `${rupees(sample.newTaxablePaise).padStart(10)}   ` +
        `${rupees(sample.newGstPaise).padStart(6)}   ` +
        `${e.rate.toFixed(3)}%`
    );
  }

  const byStatus = new Map<string, number>();
  for (const l of lines) byStatus.set(l.status, (byStatus.get(l.status) ?? 0) + 1);
  console.log(
    "\n  by status: " +
      [...byStatus.entries()].map(([s, n]) => `${s} ${n}`).join(", ")
  );

  // ── Aggregate before/after (report-visible statuses only) ──────────
  const REPORTED = ["confirmed", "dispatched", "delivered"];
  const show = (label: string, ls: Line[]) => {
    const oldTax = ls.reduce((s, l) => s + (l.lineTotalPaise - l.oldGstPaise), 0);
    const oldGst = ls.reduce((s, l) => s + l.oldGstPaise, 0);
    const newTax = ls.reduce((s, l) => s + l.newTaxablePaise, 0);
    const newGst = ls.reduce((s, l) => s + l.newGstPaise, 0);
    const gross = ls.reduce((s, l) => s + l.lineTotalPaise, 0);
    console.log(
      `\n${label}  (${ls.length} lines, ${ls.reduce((s, l) => s + l.quantity, 0)} units)\n` +
        `  taxable   ${rupees(oldTax).padStart(12)}  ->  ${rupees(newTax).padStart(12)}\n` +
        `  gst       ${rupees(oldGst).padStart(12)}  ->  ${rupees(newGst).padStart(12)}\n` +
        `  gross     ${rupees(gross).padStart(12)}  ->  ${rupees(gross).padStart(12)}   (unchanged)`
    );
    if (oldTax + oldGst !== newTax + newGst) {
      throw new Error("gross moved — refusing to write");
    }
  };
  show("IN THE GST STATEMENT", lines.filter((l) => REPORTED.includes(l.status)));
  show("ALL LINES", lines);

  // ── Header deltas, one per order ───────────────────────────────────
  const deltaByOrder = new Map<string, number>();
  for (const l of lines) {
    deltaByOrder.set(
      l.orderId,
      (deltaByOrder.get(l.orderId) ?? 0) + (l.newGstPaise - l.oldGstPaise)
    );
  }

  const orderIds = [...deltaByOrder.keys()];
  const headers = (await pgClient`
    SELECT o.id::text AS id, o.delivery_date::text AS delivery_date,
           o.subtotal::text AS subtotal, o.total_gst::text AS total_gst,
           o.grand_total::text AS grand_total
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
     WHERE oi.product_id = ${prod.id}::uuid
       AND oi.gst_percent = ${OLD_PCT}::numeric
  `) as any[];

  const grandBefore = headers.reduce((s, h) => s + paise(h.grand_total), 0);
  console.log(
    `\nHEADERS  ${headers.length} orders    ` +
      `SUM(grand_total) ${rupees(grandBefore)}  (must not move)`
  );
  for (const h of headers) {
    const d = deltaByOrder.get(h.id) ?? 0;
    const newSub = paise(h.subtotal) - d;
    const newGst = paise(h.total_gst) + d;
    if (newSub <= 0 || newGst < 0) {
      throw new Error(
        `order ${h.id}: header would go negative (subtotal ${rupees(newSub)}, gst ${rupees(newGst)})`
      );
    }
  }
  const worst = [...deltaByOrder.values()].reduce(
    (m, d) => Math.max(m, Math.abs(d)),
    0
  );
  console.log(`         largest per-order gst shift: ${rupees(worst)}`);

  // ── Write ──────────────────────────────────────────────────────────
  if (!INVOICES_ONLY) {
    if (!APPLY) {
      console.log("\nDRY RUN — nothing written. Re-run with --apply to commit.");
      return;
    }

    console.log("\nWriting...");
    await pgClient.begin(async (tx) => {
      // Lines. Guarded on the OLD values so a concurrent edit aborts the
      // run rather than being silently overwritten.
      let lineCount = 0;
      for (const l of lines) {
        const res = await tx`
          UPDATE order_items
             SET gst_percent = ${NEW_PCT}::numeric,
                 unit_price  = ${rupees(NEW_UNIT_PAISE)}::numeric,
                 gst_amount  = ${rupees(l.newGstPaise)}::numeric
           WHERE id = ${l.id}::uuid
             AND gst_percent = ${l.oldGstPercent}::numeric
             AND gst_amount  = ${rupees(l.oldGstPaise)}::numeric
        `;
        if (res.count !== 1) {
          throw new Error(
            `order_items ${l.id}: expected 1 row, got ${res.count} — ` +
              `the line changed under us, rolling back`
          );
        }
        lineCount += res.count;
      }

      // Headers. delivery_date prunes the monthly partition; the old
      // subtotal/total_gst are asserted for the same optimistic guard.
      // grand_total is deliberately absent from the SET list.
      let headerCount = 0;
      let grandAfter = 0;
      for (const h of headers) {
        const d = deltaByOrder.get(h.id)!;
        const res = (await tx`
          UPDATE orders
             SET subtotal  = ${rupees(paise(h.subtotal) - d)}::numeric,
                 total_gst = ${rupees(paise(h.total_gst) + d)}::numeric
           WHERE id            = ${h.id}::uuid
             AND delivery_date = ${h.delivery_date}::date
             AND subtotal      = ${h.subtotal}::numeric
             AND total_gst     = ${h.total_gst}::numeric
          RETURNING grand_total::text AS grand_total
        `) as any[];
        if (res.length !== 1) {
          throw new Error(
            `orders ${h.id}: expected 1 row, got ${res.length} — ` +
              `the header changed under us, rolling back`
          );
        }
        headerCount += 1;
        grandAfter += paise(res[0].grand_total);
      }

      // In-transaction invariant: the money did not move.
      if (grandAfter !== grandBefore) {
        throw new Error(
          `grand_total moved ${rupees(grandBefore)} -> ${rupees(grandAfter)} — rolling back`
        );
      }

      console.log(`  ${lineCount} order_items, ${headerCount} order headers`);
      console.log(`  SUM(grand_total) still ${rupees(grandAfter)}`);
    });
    console.log("Committed.");
  }

  // ── Reissue invoices (after commit; never throws) ───────────────────
  const targetIds = INVOICES_ONLY
    ? ((await pgClient`
        SELECT DISTINCT oi.order_id::text AS id
          FROM order_items oi
         WHERE oi.product_id = ${prod.id}::uuid
      `) as any[]).map((r) => r.id)
    : orderIds;

  if (!APPLY && !INVOICES_ONLY) return;

  console.log(`\nReissuing invoices for ${targetIds.length} orders...`);
  const tally: Record<string, number> = {};
  const failed: string[] = [];
  for (const id of targetIds) {
    const r = await reissueInvoiceIfExists(id);
    tally[r.status] = (tally[r.status] ?? 0) + 1;
    if (r.status === "failed") failed.push(id);
  }
  console.log(
    "  " +
      Object.entries(tally)
        .map(([k, v]) => `${k} ${v}`)
        .join(", ")
  );
  if (failed.length > 0) {
    console.log(`  failed order ids: ${failed.join(", ")}`);
    console.log("  re-run with --invoices-only to retry.");
  }
}

main()
  .then(() => pgClient.end())
  .catch(async (err) => {
    console.error("\nFAILED:", err instanceof Error ? err.message : err);
    await pgClient.end();
    process.exit(1);
  });
