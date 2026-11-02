// READ ONLY. Follow-ups for diag-negative-stock.ts.
// USAGE (from apps/api):  npx tsx src/diag-negative-stock-check2.ts
import { pgClient } from "./lib/db.js";
const t = (x: any) => (x ? new Date(x).toLocaleString("sv-SE", { timeZone: "Asia/Kolkata" }) : "—");
await pgClient.begin("READ ONLY", async (_tx) => {
  const sql = _tx as unknown as typeof pgClient;
  const tw = (await sql`
    SELECT r.name, tw.open_time::text, tw.close_time::text
      FROM orders o JOIN dealers d ON d.id = o.dealer_id
      JOIN routes r ON r.id = COALESCE(o.route_id, d.route_id)
      JOIN time_windows tw ON tw.route_id = r.id
     WHERE o.id::text LIKE 'c4796159%'`) as any[];
  console.log("c4796159 route windows:", tw);
  const led = (await sql`
    SELECT type::text, amount, description, created_at FROM dealer_ledger
     WHERE reference_id::text LIKE 'c4796159%' ORDER BY created_at`) as any[];
  for (const l of led) console.log(`  ledger ${l.type} ${l.amount} ${t(l.created_at)} ${l.description}`);

  console.log("\nPD0024 MUFFIN VANILLA 150GM stock log:");
  const rows = (await sql`
    SELECT f.date::text, f.opening, f.received, f.dispatched, f.wastage, f.closing,
           f.created_at, f.updated_at, u.name AS who
      FROM fgs_stock_log f JOIN products p ON p.id = f.product_id
      LEFT JOIN users u ON u.id = f.entered_by
     WHERE p.code = 'PD0024' AND f.date >= DATE '2026-10-05' ORDER BY f.date`.catch(async () => sql`
    SELECT f.date::text, f.opening, f.received, f.dispatched, f.wastage, f.closing,
           f.created_at, f.updated_at, NULL AS who
      FROM fgs_stock_log f JOIN products p ON p.id = f.product_id
     WHERE p.code = 'PD0024' AND f.date >= DATE '2026-10-05' ORDER BY f.date`)) as any[];
  for (const r of rows)
    console.log(`  ${r.date} op=${r.opening} rec=${r.received} disp=${r.dispatched} wast=${r.wastage} close=${r.closing} created=${t(r.created_at)} updated=${t(r.updated_at)} ${r.who ?? ""}`);
  const rc = (await sql`
    SELECT sr.date::text, sr.quantity, sr.created_at FROM stock_receipts sr
      JOIN products p ON p.id = sr.product_id
     WHERE p.code = 'PD0024' AND sr.date >= DATE '2026-10-05' ORDER BY sr.date`) as any[];
  for (const r of rc) console.log(`  receipt ${r.date} qty=${r.quantity} at=${t(r.created_at)}`);
  const ords = (await sql`
    SELECT o.delivery_date::text AS dd, left(o.id::text,8) AS id, o.status::text, o.stock_deducted,
           oi.quantity, o.created_at, o.cancelled_at, o.cancellation_reason
      FROM orders o JOIN order_items oi ON oi.order_id = o.id JOIN products p ON p.id = oi.product_id
     WHERE p.code = 'PD0024' AND o.delivery_date >= DATE '2026-10-10' ORDER BY o.created_at`) as any[];
  for (const o of ords)
    console.log(`  order ${o.dd} ${o.id} ${o.status} deducted=${o.stock_deducted} qty=${o.quantity} created=${t(o.created_at)} cancelled=${t(o.cancelled_at)} ${o.cancellation_reason ?? ""}`);
  const avail = (await sql`
    SELECT d::date::text AS d, (SELECT closing FROM fgs_day(d::date) x JOIN products p ON p.id = x.product_id WHERE p.code='PD0024') AS closing
      FROM generate_series(DATE '2026-10-08', DATE '2026-10-14', interval '1 day') d`) as any[];
  console.log("  derived closings:", avail.map((a) => `${a.d}=${a.closing}`).join("  "));
});
await pgClient.end();
