// ═══════════════════════════════════════════════════════════════════════
// diag-delete-precut-test-data.ts — DESTRUCTIVE. Deletes production rows.
//
// Removes the pre-launch test sales: everything dated before 2026-06-20.
// Approved by the client on 2026-08-10, explicitly WITHOUT anchoring the
// FGS opening chain — so today's stock figures move by whatever those test
// orders had contributed. `fgs_day()` derives outflow live from orders /
// order_items and the first post-cut day (2026-06-20) carries its opening
// from 2026-06-18's closing, so deleting the history changes it. The script
// prints the before/after delta rather than hiding it.
//
// Every affected row is copied into schema `backup_precut` first. To undo,
// insert the backup tables back (orders before order_items/invoices).
//
// Scope — sales only. Deliberately NOT touched:
//   • fgs_stock_log      — stock records, not sales
//   • payments / dealer_ledger — one ₹1.00 top-up probe, a receipt not a sale
//
// USAGE (from apps/api):
//   npx tsx src/diag-delete-precut-test-data.ts          — dry run, no writes
//   npx tsx src/diag-delete-precut-test-data.ts --apply  — perform the delete
// ═══════════════════════════════════════════════════════════════════════

import { pgClient } from "./lib/db.js";

const CUT = "2026-06-20";
const APPLY = process.argv.includes("--apply");

const n = (v: any) => Number(v) || 0;
const inr = (v: any) => "₹" + n(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function counts() {
  const [c] = await pgClient`
    SELECT
      (SELECT count(*)::int FROM orders WHERE created_at < ${CUT}::date) AS orders,
      (SELECT count(*)::int FROM order_items oi
        WHERE EXISTS (SELECT 1 FROM orders o WHERE o.id = oi.order_id AND o.created_at < ${CUT}::date)) AS order_items,
      (SELECT count(*)::int FROM invoices i
        WHERE EXISTS (SELECT 1 FROM orders o WHERE o.id = i.order_id AND o.created_at < ${CUT}::date)) AS invoices,
      (SELECT count(*)::int FROM razorpay_payments rp
        WHERE EXISTS (SELECT 1 FROM orders o WHERE o.id = rp.order_id AND o.created_at < ${CUT}::date)) AS razorpay,
      (SELECT count(*)::int FROM direct_sales WHERE sale_date < ${CUT}::date) AS direct_sales,
      (SELECT count(*)::int FROM direct_sale_items dsi
        WHERE EXISTS (SELECT 1 FROM direct_sales ds WHERE ds.id = dsi.direct_sale_id AND ds.sale_date < ${CUT}::date)) AS direct_sale_items,
      (SELECT count(*)::int FROM gate_pass_items gpi
        WHERE EXISTS (SELECT 1 FROM direct_sales ds WHERE ds.id = gpi.direct_sale_id AND ds.sale_date < ${CUT}::date)) AS gate_pass_items
  `;
  return c as any;
}

async function main() {
  console.log(`${APPLY ? "APPLYING" : "DRY RUN"} — delete every sale dated before ${CUT}\n`);

  const before = await counts();
  console.log("rows in scope:");
  console.table([before]);

  // FGS state as it stands now, for the after-comparison.
  const fgsBefore = await pgClient`
    SELECT product_id, opening, closing FROM fgs_day(CURRENT_DATE)
  `;
  const fgsBeforeMap = new Map((fgsBefore as any[]).map(r => [r.product_id, r]));
  const sumBefore = (fgsBefore as any[]).reduce((s, r) => s + n(r.closing), 0);
  console.log(`FGS closing across all products today, before: ${sumBefore} units\n`);

  if (!APPLY) {
    console.log("Dry run only. Re-run with --apply to perform the delete.");
    await pgClient.end();
    return;
  }

  // ── 1. Backup ──────────────────────────────────────────────────────
  // Plain table copies, no constraints, so a restore is a straight INSERT
  // SELECT and nothing here can interfere with the live schema.
  await pgClient`CREATE SCHEMA IF NOT EXISTS backup_precut`;
  await pgClient`DROP TABLE IF EXISTS backup_precut.orders`;
  await pgClient`CREATE TABLE backup_precut.orders AS
                   SELECT * FROM orders WHERE created_at < ${CUT}::date`;
  await pgClient`DROP TABLE IF EXISTS backup_precut.order_items`;
  await pgClient`CREATE TABLE backup_precut.order_items AS
                   SELECT oi.* FROM order_items oi
                    WHERE EXISTS (SELECT 1 FROM orders o WHERE o.id = oi.order_id AND o.created_at < ${CUT}::date)`;
  await pgClient`DROP TABLE IF EXISTS backup_precut.invoices`;
  await pgClient`CREATE TABLE backup_precut.invoices AS
                   SELECT i.* FROM invoices i
                    WHERE EXISTS (SELECT 1 FROM orders o WHERE o.id = i.order_id AND o.created_at < ${CUT}::date)`;
  await pgClient`DROP TABLE IF EXISTS backup_precut.razorpay_payments`;
  await pgClient`CREATE TABLE backup_precut.razorpay_payments AS
                   SELECT rp.* FROM razorpay_payments rp
                    WHERE EXISTS (SELECT 1 FROM orders o WHERE o.id = rp.order_id AND o.created_at < ${CUT}::date)`;
  await pgClient`DROP TABLE IF EXISTS backup_precut.direct_sales`;
  await pgClient`CREATE TABLE backup_precut.direct_sales AS
                   SELECT * FROM direct_sales WHERE sale_date < ${CUT}::date`;
  await pgClient`DROP TABLE IF EXISTS backup_precut.direct_sale_items`;
  await pgClient`CREATE TABLE backup_precut.direct_sale_items AS
                   SELECT dsi.* FROM direct_sale_items dsi
                    WHERE EXISTS (SELECT 1 FROM direct_sales ds WHERE ds.id = dsi.direct_sale_id AND ds.sale_date < ${CUT}::date)`;
  await pgClient`DROP TABLE IF EXISTS backup_precut.gate_pass_items`;
  await pgClient`CREATE TABLE backup_precut.gate_pass_items AS
                   SELECT gpi.* FROM gate_pass_items gpi
                    WHERE EXISTS (SELECT 1 FROM direct_sales ds WHERE ds.id = gpi.direct_sale_id AND ds.sale_date < ${CUT}::date)`;
  const [bk] = await pgClient`
    SELECT (SELECT count(*)::int FROM backup_precut.orders) AS orders,
           (SELECT count(*)::int FROM backup_precut.order_items) AS order_items,
           (SELECT count(*)::int FROM backup_precut.invoices) AS invoices,
           (SELECT count(*)::int FROM backup_precut.razorpay_payments) AS razorpay,
           (SELECT count(*)::int FROM backup_precut.direct_sales) AS direct_sales,
           (SELECT count(*)::int FROM backup_precut.direct_sale_items) AS direct_sale_items,
           (SELECT count(*)::int FROM backup_precut.gate_pass_items) AS gate_pass_items
  `;
  console.log("backed up into schema backup_precut:");
  console.table([bk]);

  // ── 2. Delete, children first, one transaction ─────────────────────
  // razorpay_payments.order_id has no FK (orders is partitioned), so those
  // rows would survive as orphans pointing at deleted orders; they go first.
  // direct_sale_items and gate_pass_items cascade from direct_sales, but are
  // deleted explicitly so the counts below are exact.
  const deleted = await pgClient.begin(async (_tx) => {
    const tx = _tx as unknown as typeof pgClient;
    const d: Record<string, number> = {};

    d.razorpay = (await tx`
      DELETE FROM razorpay_payments rp
       WHERE EXISTS (SELECT 1 FROM orders o WHERE o.id = rp.order_id AND o.created_at < ${CUT}::date)
    `).count;
    d.invoices = (await tx`
      DELETE FROM invoices i
       WHERE EXISTS (SELECT 1 FROM orders o WHERE o.id = i.order_id AND o.created_at < ${CUT}::date)
    `).count;
    d.order_items = (await tx`
      DELETE FROM order_items oi
       WHERE EXISTS (SELECT 1 FROM orders o WHERE o.id = oi.order_id AND o.created_at < ${CUT}::date)
    `).count;
    d.orders = (await tx`
      DELETE FROM orders WHERE created_at < ${CUT}::date
    `).count;
    d.gate_pass_items = (await tx`
      DELETE FROM gate_pass_items gpi
       WHERE EXISTS (SELECT 1 FROM direct_sales ds WHERE ds.id = gpi.direct_sale_id AND ds.sale_date < ${CUT}::date)
    `).count;
    d.direct_sale_items = (await tx`
      DELETE FROM direct_sale_items dsi
       WHERE EXISTS (SELECT 1 FROM direct_sales ds WHERE ds.id = dsi.direct_sale_id AND ds.sale_date < ${CUT}::date)
    `).count;
    d.direct_sales = (await tx`
      DELETE FROM direct_sales WHERE sale_date < ${CUT}::date
    `).count;
    return d;
  });

  console.log("deleted:");
  console.table([deleted]);

  // ── 3. Verify nothing survived, and report the FGS movement ────────
  console.log("remaining in scope (must be all zero):");
  console.table([await counts()]);

  const fgsAfter = await pgClient`
    SELECT product_id, opening, closing FROM fgs_day(CURRENT_DATE)
  `;
  const sumAfter = (fgsAfter as any[]).reduce((s, r) => s + n(r.closing), 0);
  const moved = (fgsAfter as any[])
    .map(r => ({
      product_id: r.product_id,
      before: n(fgsBeforeMap.get(r.product_id)?.closing),
      after: n(r.closing),
    }))
    .filter(r => r.before !== r.after);

  console.log(`\nFGS closing across all products today: ${sumBefore} → ${sumAfter} (delta ${sumAfter - sumBefore})`);
  console.log(`products whose closing moved: ${moved.length}`);
  if (moved.length) {
    const names = await pgClient`
      SELECT id, code, name FROM products WHERE id = ANY(${moved.map(m => m.product_id)})
    `;
    const nameOf = new Map((names as any[]).map(p => [p.id, `${p.code} ${p.name}`]));
    console.table(moved.slice(0, 40).map(m => ({
      product: nameOf.get(m.product_id) ?? m.product_id,
      before: m.before, after: m.after, delta: m.after - m.before,
    })));
  }

  await pgClient.end();
}

main().catch(e => { console.error(e); process.exit(1); });
