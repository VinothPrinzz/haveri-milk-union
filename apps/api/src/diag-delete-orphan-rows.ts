// ═══════════════════════════════════════════════════════════════════════
// diag-delete-orphan-rows.ts — DESTRUCTIVE. Deletes production rows.
//
// Removes rows left pointing at orders that no longer exist. They predate
// the 2026-06-20 test-data purge (verified against backup_precut) and no
// live code path deletes from `orders`, so this is old damage, not an
// ongoing leak. Nothing reads them — every report joins outward FROM orders
// or direct_sales — so this is tidying, not a behaviour change.
//
// What counts as an orphan, precisely:
//   • order_items       — no row in `orders` with that id
//   • invoices          — order_id set, but matching NEITHER `orders`,
//                         `employee_orders`, NOR `direct_sales`. That last
//                         one matters: since migration 0071 a counter-sale
//                         invoice stores a direct_sale id in order_id, and
//                         omitting the check misreads 5 healthy invoices
//                         (including today's) as orphans.
//   • razorpay_payments — order_id set with no matching order. Rows with a
//                         NULL order_id are gate-pass QRs and are untouched.
//
// Refuses to run if any orphan carries real money: a razorpay row that ever
// reached 'paid'/'refunded', or an invoice with a payment against it.
//
// Rows are copied to schema `backup_orphans` first.
//
// USAGE (from apps/api):
//   npx tsx src/diag-delete-orphan-rows.ts          — dry run, no writes
//   npx tsx src/diag-delete-orphan-rows.ts --apply  — perform the delete
// ═══════════════════════════════════════════════════════════════════════

import { pgClient } from "./lib/db.js";

const APPLY = process.argv.includes("--apply");

async function main() {
  console.log(`${APPLY ? "APPLYING" : "DRY RUN"} — delete rows orphaned from deleted orders\n`);

  const [scope] = await pgClient`
    SELECT
      (SELECT count(*)::int FROM order_items oi
        WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = oi.order_id)) AS order_items,
      (SELECT count(*)::int FROM invoices i
        WHERE i.order_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = i.order_id)
          AND NOT EXISTS (SELECT 1 FROM employee_orders e WHERE e.id = i.order_id)
          AND NOT EXISTS (SELECT 1 FROM direct_sales ds WHERE ds.id = i.order_id)) AS invoices,
      (SELECT count(*)::int FROM razorpay_payments rp
        WHERE rp.order_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = rp.order_id)) AS razorpay
  `;
  console.log("rows in scope:");
  console.table([scope]);

  // ── Safety gates: refuse if any of it represents money ──
  const [risk] = await pgClient`
    SELECT
      (SELECT count(*)::int FROM razorpay_payments rp
        WHERE rp.order_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = rp.order_id)
          AND rp.status::text IN ('paid', 'refunded')) AS paid_razorpay,
      (SELECT count(*)::int FROM payments p
        WHERE p.invoice_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM invoices i WHERE i.id = p.invoice_id
            AND i.order_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = i.order_id)
            AND NOT EXISTS (SELECT 1 FROM employee_orders e WHERE e.id = i.order_id)
            AND NOT EXISTS (SELECT 1 FROM direct_sales ds WHERE ds.id = i.order_id))) AS payments_on_orphan_invoices,
      (SELECT count(*)::int FROM ledger_adjustments la
        WHERE la.invoice_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM invoices i WHERE i.id = la.invoice_id
            AND i.order_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = i.order_id)
            AND NOT EXISTS (SELECT 1 FROM employee_orders e WHERE e.id = i.order_id)
            AND NOT EXISTS (SELECT 1 FROM direct_sales ds WHERE ds.id = i.order_id))) AS adjustments_on_orphan_invoices
  `;
  console.log("safety gates (all must be 0):");
  console.table([risk]);
  const r = risk as any;
  if (r.paid_razorpay || r.payments_on_orphan_invoices || r.adjustments_on_orphan_invoices) {
    console.error("\nABORT — an orphan carries money or is referenced by a receipt. Nothing deleted.");
    await pgClient.end();
    process.exit(1);
  }

  if (!APPLY) {
    console.log("\nDry run only. Re-run with --apply to perform the delete.");
    await pgClient.end();
    return;
  }

  await pgClient`CREATE SCHEMA IF NOT EXISTS backup_orphans`;
  await pgClient`DROP TABLE IF EXISTS backup_orphans.order_items`;
  await pgClient`CREATE TABLE backup_orphans.order_items AS
    SELECT oi.* FROM order_items oi
     WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = oi.order_id)`;
  await pgClient`DROP TABLE IF EXISTS backup_orphans.invoices`;
  await pgClient`CREATE TABLE backup_orphans.invoices AS
    SELECT i.* FROM invoices i
     WHERE i.order_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = i.order_id)
       AND NOT EXISTS (SELECT 1 FROM employee_orders e WHERE e.id = i.order_id)
       AND NOT EXISTS (SELECT 1 FROM direct_sales ds WHERE ds.id = i.order_id)`;
  await pgClient`DROP TABLE IF EXISTS backup_orphans.razorpay_payments`;
  await pgClient`CREATE TABLE backup_orphans.razorpay_payments AS
    SELECT rp.* FROM razorpay_payments rp
     WHERE rp.order_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = rp.order_id)`;

  const [bk] = await pgClient`
    SELECT (SELECT count(*)::int FROM backup_orphans.order_items) AS order_items,
           (SELECT count(*)::int FROM backup_orphans.invoices) AS invoices,
           (SELECT count(*)::int FROM backup_orphans.razorpay_payments) AS razorpay
  `;
  console.log("backed up into schema backup_orphans:");
  console.table([bk]);

  const deleted = await pgClient.begin(async (_tx) => {
    const tx = _tx as unknown as typeof pgClient;
    const d: Record<string, number> = {};
    d.order_items = (await tx`
      DELETE FROM order_items oi
       WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = oi.order_id)
    `).count;
    d.invoices = (await tx`
      DELETE FROM invoices i
       WHERE i.order_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = i.order_id)
         AND NOT EXISTS (SELECT 1 FROM employee_orders e WHERE e.id = i.order_id)
         AND NOT EXISTS (SELECT 1 FROM direct_sales ds WHERE ds.id = i.order_id)
    `).count;
    d.razorpay = (await tx`
      DELETE FROM razorpay_payments rp
       WHERE rp.order_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = rp.order_id)
    `).count;
    return d;
  });
  console.log("deleted:");
  console.table([deleted]);

  // ── Verify: scope empty, and the healthy counter-sale invoices survive ──
  const [after] = await pgClient`
    SELECT
      (SELECT count(*)::int FROM order_items oi
        WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = oi.order_id)) AS orphan_order_items,
      (SELECT count(*)::int FROM invoices i
        WHERE i.order_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = i.order_id)
          AND NOT EXISTS (SELECT 1 FROM employee_orders e WHERE e.id = i.order_id)
          AND NOT EXISTS (SELECT 1 FROM direct_sales ds WHERE ds.id = i.order_id)) AS orphan_invoices,
      (SELECT count(*)::int FROM razorpay_payments rp
        WHERE rp.order_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = rp.order_id)) AS orphan_razorpay,
      (SELECT count(*)::int FROM invoices i
        WHERE EXISTS (SELECT 1 FROM direct_sales ds WHERE ds.id = i.order_id)) AS counter_sale_invoices_kept,
      (SELECT count(*)::int FROM invoices) AS invoices_total
  `;
  console.log("after (orphans 0, counter-sale invoices intact):");
  console.table([after]);

  await pgClient.end();
}

main().catch(e => { console.error(e); process.exit(1); });
