// Read-only: the Route Sheet must foot a dealer's collected and credit supply
// on SEPARATE rows. Replays the sheet's own grouping (routes/reports.ts 7a/7b)
// for every date+route where a dealer has more than one settlement rail.
import { pgClient } from "./lib/db.js";
import { isCreditSupplyOrder } from "./lib/credit-check.js";

async function main() {
  const days = await pgClient`
    SELECT DISTINCT o.delivery_date::text AS dd
      FROM orders o JOIN dealers d ON d.id = o.dealer_id
     WHERE o.status IN ('confirmed','dispatched','delivered')
       AND COALESCE(d.customer_type::text,'') LIKE 'Credit Inst%'
     ORDER BY 1 DESC LIMIT 400
  ` as any[];

  let splits = 0;
  for (const { dd } of days) {
    const itemRows = await pgClient`
      SELECT o.dealer_id::text AS dealer_id,
             COALESCE(o.route_id, d.route_id)::text AS route_id,
             r.name AS route_name,
             d.code AS dealer_code, d.name AS dealer_name,
             d.customer_type AS customer_type,
             o.payment_mode  AS payment_mode,
             oi.line_total::numeric AS amount
        FROM orders o
        JOIN dealers d      ON d.id = o.dealer_id
        JOIN order_items oi ON oi.order_id = o.id
        LEFT JOIN routes r  ON r.id = COALESCE(o.route_id, d.route_id)
       WHERE o.delivery_date = ${dd}::date
         AND o.status IN ('confirmed','dispatched','delivered')
    ` as any[];

    // Same keying as routes/reports.ts step 7b.
    const dealerRailRows = new Map<string, Map<boolean, string>>();
    const rows = new Map<string, any>();
    for (const it of itemRows) {
      const orderIsCredit = isCreditSupplyOrder({
        customerType: it.customer_type, paymentMode: it.payment_mode,
      });
      const dealerKey = `${it.route_id}:${it.dealer_id}`;
      let rails = dealerRailRows.get(dealerKey);
      if (!rails) { rails = new Map(); dealerRailRows.set(dealerKey, rails); }
      let rowKey: string | undefined = rails.get(orderIsCredit);
      if (rowKey === undefined) {
        rowKey = rails.size === 0
          ? String(it.dealer_id)
          : `${it.dealer_id}:${orderIsCredit ? "CR" : "CASH"}`;
        rails.set(orderIsCredit, rowKey);
      }
      const k = `${it.route_id}|${rowKey}`;
      const cur = rows.get(k) ?? {
        route: it.route_name, code: it.dealer_code, name: it.dealer_name,
        isCredit: orderIsCredit, net: 0,
      };
      cur.isCredit = orderIsCredit;
      cur.net += parseFloat(it.amount) || 0;
      rows.set(k, cur);
    }

    for (const [dealerKey, rails] of dealerRailRows) {
      if (rails.size < 2) continue;
      splits += 1;
      const routeId = dealerKey.split(":")[0] ?? "";
      console.log(`\n${dd}   route ${routeId.slice(0, 8)}`);
      for (const rowKey of rails.values()) {
        const r = rows.get(`${routeId}|${rowKey}`);
        if (!r) continue;
        console.log(`  ${String(r.route ?? "-").padEnd(16)} ${String(r.code).padEnd(6)} ` +
          `${String(r.name).slice(0,26).padEnd(28)} ${r.net.toFixed(2).padStart(11)}` +
          `${r.isCredit ? " (credit)" : ""}`);
      }
    }
  }
  console.log(`\ndealer rows split across two rails: ${splits}`);
  await pgClient.end();
}
main().catch(async (e) => { console.error(e); await pgClient.end(); process.exit(1); });
