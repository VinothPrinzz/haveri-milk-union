// READ ONLY. Which products/days go negative on the FGS model, and which
// outflow event pushed each one below zero?
//
// For every post-cutover date up to today, runs fgs_day() and collects rows
// with closing < 0. For the FIRST negative day of each product it replays that
// day's outflows in commit-time order from (opening + received − wastage) and
// names the event that crossed zero, classified by the rail that created it.
// Also checks stored fgs_stock_log openings against the derived chain.
//
// USAGE (from apps/api):  npx tsx src/diag-negative-stock.ts
import { pgClient } from "./lib/db.js";

await pgClient.begin("READ ONLY", async (_tx) => {
  const sql = _tx as unknown as typeof pgClient;

  const [{ today, cutover }] = (await sql`
    SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS today,
           (SELECT MIN(date) FROM fgs_stock_log WHERE opening_manual)::text AS cutover
  `) as any[];
  console.log(`IST today: ${today}   cutover: ${cutover}\n`);

  // ── 1. Every negative (product, date) since cutover ──
  const neg = (await sql`
    SELECT d::date::text AS date, p.id AS product_id, p.code, p.name,
           fd.opening, fd.received, fd.dispatched, fd.wastage, fd.closing
      FROM generate_series(${cutover}::date, ${today}::date, interval '1 day') d
      CROSS JOIN LATERAL fgs_day(d::date) fd
      JOIN products p ON p.id = fd.product_id
     WHERE fd.closing < 0
       AND p.stock_source_product_id IS NULL
     ORDER BY p.code, d
  `) as any[];

  const byProduct = new Map<string, any[]>();
  for (const r of neg) {
    if (!byProduct.has(r.product_id)) byProduct.set(r.product_id, []);
    byProduct.get(r.product_id)!.push(r);
  }
  console.log(`── ${neg.length} negative product-days across ${byProduct.size} products ──`);
  for (const rows of byProduct.values()) {
    const last = rows[rows.length - 1];
    console.log(
      `  ${rows[0].code} ${String(rows[0].name).padEnd(30)} days=${rows.length} ` +
        `first=${rows[0].date} last=${last.date} (closing ${last.closing})`,
    );
  }

  // Which dates go negative "fresh" (opening >= 0 but closing < 0) — those are
  // the days something new happened. Days with opening < 0 just carry it.
  const tally: Record<string, number> = {};
  const bump = (k: string, n = 1) => (tally[k] = (tally[k] ?? 0) + n);

  for (const rows of byProduct.values()) {
    const fresh = rows.filter((r) => Number(r.opening) >= 0);
    for (const day of fresh) {
      const pid = day.product_id;
      console.log(
        `\n══ ${day.code} ${day.name}  ${day.date} ══  opening=${day.opening} ` +
          `received=${day.received} wastage=${day.wastage} dispatched=${day.dispatched} closing=${day.closing}`,
      );

      const [log] = (await sql`
        SELECT opening, received, wastage, opening_manual,
               created_at, updated_at
          FROM fgs_stock_log WHERE product_id = ${pid}::uuid AND date = ${day.date}::date
      `) as any[];
      if (log)
        console.log(
          `  stock log: stored opening=${log.opening} rec=${log.received} wast=${log.wastage}` +
            `${log.opening_manual ? " [manual]" : ""} created=${iso(log.created_at)} updated=${iso(log.updated_at)}`,
        );
      else console.log("  stock log: NO ROW for this day (opening carried, received/wastage = 0)");

      // Outflow events on this date, with the rail that produced them.
      const events = (await sql`
        SELECT * FROM (
          SELECT 'order' AS rail,
                 left(o.id::text, 8) AS ref,
                 COALESCE(o.confirmed_at, o.created_at) AS at,
                 o.created_at, o.confirmed_at, o.status::text AS status,
                 o.payment_mode::text AS pay,
                 (o.placed_by IS NOT NULL) AS admin_placed,
                 EXISTS (SELECT 1 FROM dealer_ledger dl
                          WHERE dl.reference_id = o.id
                            AND dl.description LIKE 'Auto-confirmed standing-indent%') AS auto_confirmed,
                 (SELECT MAX(oi2.created_at) FROM order_items oi2 WHERE oi2.order_id = o.id) AS items_at,
                 SUM(oi.quantity)::int AS qty,
                 NULL::text AS extra
            FROM orders o
            JOIN order_items oi ON oi.order_id = o.id
            JOIN products pp ON pp.id = oi.product_id
           WHERE o.stock_deducted AND o.status <> 'cancelled'
             AND COALESCE(pp.stock_source_product_id, pp.id) = ${pid}::uuid
             AND o.delivery_date = ${day.date}::date
           GROUP BY o.id, o.created_at, o.confirmed_at, o.status, o.payment_mode, o.placed_by
          UNION ALL
          SELECT 'direct_sale', COALESCE(ds.gp_no, left(ds.id::text, 8)),
                 ds.created_at, ds.created_at, NULL, ds.status::text,
                 ds.payment_mode::text, true, false, ds.updated_at,
                 (SUM(di.quantity) - COALESCE((SELECT SUM(g.returned_quantity) FROM gate_pass_items g
                                                JOIN products gp ON gp.id = g.product_id
                                               WHERE g.direct_sale_id = ds.id
                                                 AND COALESCE(gp.stock_source_product_id, gp.id) = ${pid}::uuid), 0))::int,
                 ds.customer_type::text
            FROM direct_sales ds
            JOIN direct_sale_items di ON di.direct_sale_id = ds.id
            JOIN products pp ON pp.id = di.product_id
           WHERE ds.status = 'confirmed'
             AND COALESCE(pp.stock_source_product_id, pp.id) = ${pid}::uuid
             AND ds.sale_date = ${day.date}::date
           GROUP BY ds.id
          UNION ALL
          SELECT 'employee', left(eo.id::text, 8),
                 COALESCE(eo.confirmed_at, eo.updated_at), eo.created_at, eo.confirmed_at,
                 eo.status::text, eo.payment_mode::text, false, false, NULL,
                 SUM(ei.quantity)::int, NULL
            FROM employee_orders eo
            JOIN employee_order_items ei ON ei.employee_order_id = eo.id
            JOIN products pp ON pp.id = ei.product_id
           WHERE eo.status NOT IN ('draft', 'cancelled')
             AND COALESCE(pp.stock_source_product_id, pp.id) = ${pid}::uuid
             AND eo.delivery_date = ${day.date}::date
           GROUP BY eo.id
        ) e ORDER BY at
      `) as any[];

      let bal = Number(day.opening) + Number(day.received) - Number(day.wastage);
      console.log(`  start balance (opening + received − wastage) = ${bal}`);
      let culprit: string | null = null;
      for (const e of events) {
        const before = bal;
        bal -= Number(e.qty);
        const src = classify(e, day.date);
        const crossed = before >= 0 && bal < 0;
        if (crossed && !culprit) culprit = src;
        console.log(
          `   ${crossed ? "→" : " "} ${iso(e.at)}  ${src.padEnd(34)} ${String(e.ref).padEnd(10)} ` +
            `${String(e.status).padEnd(16)} pay=${String(e.pay).padEnd(7)} qty=${String(e.qty).padStart(5)} ` +
            `bal=${String(bal).padStart(6)}`,
        );
      }
      if (!culprit) {
        // Events alone never crossed zero → received/wastage moved afterwards,
        // or the carried opening shrank after the fact.
        culprit = events.length === 0 ? "no outflow (opening/wastage)" : "stock-entry edit after commits";
        console.log(`  (no single event crossed zero — ${culprit})`);
      }
      bump(culprit);
      bump(`   units over: ${culprit}`, -Number(day.closing));
    }
  }

  // ── 2. Stored opening vs. derived chain (drift that fgs_available trusts) ──
  const drift = (await sql`
    SELECT f.date::text AS date, p.code, p.name, f.opening AS stored, fd.opening AS derived
      FROM fgs_stock_log f
      JOIN products p ON p.id = f.product_id
      CROSS JOIN LATERAL (SELECT opening FROM fgs_day(f.date) x WHERE x.product_id = f.product_id) fd
     WHERE f.date >= ${cutover}::date AND NOT f.opening_manual
       AND f.opening <> fd.opening
     ORDER BY p.code, f.date
  `) as any[];
  console.log(`\n── stored opening ≠ derived opening: ${drift.length} rows ──`);
  for (const d of drift.slice(0, 40))
    console.log(`  ${d.date} ${d.code} ${String(d.name).padEnd(30)} stored=${d.stored} derived=${d.derived}`);

  // ── 3. Today's live availability (what the gate sees) ──
  const live = (await sql`
    SELECT p.code, p.name, fgs_available(p.id, ${today}::date) AS n
      FROM products p
     WHERE p.deleted_at IS NULL AND p.stock_source_product_id IS NULL
       AND fgs_available(p.id, ${today}::date) < 0
     ORDER BY 3
  `) as any[];
  console.log(`\n── fgs_available(today) < 0: ${live.length} products ──`);
  for (const l of live) console.log(`  ${l.code} ${String(l.name).padEnd(30)} ${l.n}`);

  console.log("\n══ SUMMARY: what crossed zero on each fresh negative day ══");
  for (const [k, v] of Object.entries(tally).sort()) console.log(`  ${k.padEnd(48)} ${v}`);
});

await pgClient.end();

function iso(t: any): string {
  if (!t) return "—".padEnd(16);
  return new Date(t).toLocaleString("sv-SE", { timeZone: "Asia/Kolkata" }).slice(0, 16);
}

function classify(e: any, date: string): string {
  if (e.rail === "direct_sale") {
    const created = iso(e.created_at).slice(0, 10);
    return `direct sale (${e.extra})${created > date ? " BACK-DATED" : ""}`;
  }
  if (e.rail === "employee") return `employee indent (${e.status})`;
  const editedLater =
    e.items_at && e.confirmed_at && new Date(e.items_at).getTime() - new Date(e.confirmed_at).getTime() > 60_000;
  let s = e.auto_confirmed ? "order: worker auto-confirm" : e.admin_placed ? "order: admin/call-desk" : "order: dealer app";
  if (e.pay === "upi" || e.pay === "online") s += " [paid]";
  if (editedLater) s += " +EDITED";
  return s;
}
