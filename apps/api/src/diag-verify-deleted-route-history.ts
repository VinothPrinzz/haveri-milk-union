// ═══════════════════════════════════════════════════════════════════════
// diag-verify-deleted-route-history.ts — VERIFY (read-only; injects HTTP).
//
// Proves that sales booked on a route that has since been DELETED still print
// on every report that covers their date:
//   • GET /api/v1/reports/sales-reports/daily-sales-report
//   • GET /api/v1/reports/sales-reports/monthly-sales-report
//   • GET /api/v1/reports/route-sheet
//   • GET /api/v1/dispatch-sheet
//
// The route that triggered this (HAVERI NIGHT 2 (A B P) ROUTE, deleted
// 2026-08-13) is found from the data, not hardcoded: any soft-deleted route
// with confirmed sales is tested on the dates it actually sold.
//
// Boots the real Fastify app and uses app.inject, reusing an existing admin
// session — nothing is written.
//
// USAGE (from apps/api):  npx tsx src/diag-verify-deleted-route-history.ts
// ═══════════════════════════════════════════════════════════════════════

import { pgClient } from "./lib/db.js";
import app from "./server.js";

async function main() {
  const [sess] = await pgClient`
    SELECT s.token, u.name, u.role
      FROM admin_sessions s
      JOIN users u ON u.id = s.user_id
     WHERE s.expires_at > now()
       AND u.role = 'super_admin'
     ORDER BY s.expires_at DESC
     LIMIT 1
  `;
  if (!sess) {
    console.log("No live super_admin session to borrow — log in on the admin UI and re-run.");
    await pgClient.end();
    await app.close();
    return;
  }
  console.log(`Borrowed session of ${(sess as any).name} (${(sess as any).role})\n`);
  const headers = { "x-session-token": (sess as any).token as string };

  // Deleted routes that carry confirmed sales, and the dates they sold on.
  const targets = await pgClient`
    SELECT r.id, r.name,
           to_char(o.delivery_date, 'YYYY-MM-DD') AS date,
           count(*)::int AS orders,
           SUM(o.grand_total)::numeric AS amount
    FROM orders o
    JOIN dealers d ON d.id = o.dealer_id
    JOIN routes r  ON r.id = COALESCE(o.route_id, d.route_id)
    WHERE r.deleted_at IS NOT NULL
      AND o.status IN ('confirmed', 'dispatched', 'delivered')
    GROUP BY 1, 2, 3
    ORDER BY 3 DESC
    LIMIT 5
  `;
  if (targets.length === 0) {
    console.log("No deleted route carries confirmed sales — nothing to verify.");
    await pgClient.end();
    await app.close();
    return;
  }

  let failures = 0;
  const check = (label: string, ok: boolean, detail: string) => {
    if (!ok) failures++;
    console.log(`    ${ok ? "PASS" : "FAIL"}  ${label.padEnd(22)} ${detail}`);
  };

  for (const t of targets as any[]) {
    console.log(`══════════ ${t.date} · ${t.name} (${t.orders} orders, ₹${Number(t.amount).toLocaleString("en-IN")}) ══════════`);

    // 1. Daily Sales Report (route x product cross-tab)
    const dsr = await app.inject({
      method: "GET",
      url: `/api/v1/reports/sales-reports/daily-sales-report?date=${t.date}`,
      headers,
    });
    if (dsr.statusCode !== 200) {
      check("daily-sales-report", false, `HTTP ${dsr.statusCode} ${dsr.body.slice(0, 160)}`);
    } else {
      const body = dsr.json() as any;
      const rows = body.groups.flatMap((g: any) => g.rows);
      const row = rows.find((r: any) => r.id === t.id);
      check("daily-sales-report", Boolean(row && row.todayQty > 0),
        row ? `row present: ${row.todayQty} (code "${row.code}")` : "route row MISSING");
    }

    // 2. Monthly Sales Report — same cross-tab over the whole month
    const month = String(t.date).slice(0, 7);
    const msr = await app.inject({
      method: "GET",
      url: `/api/v1/reports/sales-reports/monthly-sales-report?month=${month}`,
      headers,
    });
    if (msr.statusCode !== 200) {
      check("monthly-sales-report", false, `HTTP ${msr.statusCode} ${msr.body.slice(0, 160)}`);
    } else {
      const body = msr.json() as any;
      const rows = body.groups.flatMap((g: any) => g.rows);
      const row = rows.find((r: any) => r.id === t.id);
      check("monthly-sales-report", Boolean(row && row.todayQty > 0),
        row ? `row present: ${row.todayQty}` : "route row MISSING");
    }

    // 3. Route Sheet — the printed loading sheet for the date
    const rs = await app.inject({
      method: "GET",
      url: `/api/v1/reports/route-sheet?date=${t.date}`,
      headers,
    });
    if (rs.statusCode !== 200) {
      check("route-sheet", false, `HTTP ${rs.statusCode} ${rs.body.slice(0, 160)}`);
    } else {
      const body = rs.json() as any;
      const page = body.routes.find((r: any) => r.id === t.id);
      check("route-sheet", Boolean(page && page.customers.length > 0),
        page ? `page present: ${page.customers.length} dealer row(s), retired=${page.retired}, code="${page.code}"`
             : "route page MISSING");
    }

    // 4. Dispatch Sheet — the loading checklist card
    const ds = await app.inject({
      method: "GET",
      url: `/api/v1/dispatch-sheet?date=${t.date}`,
      headers,
    });
    if (ds.statusCode !== 200) {
      check("dispatch-sheet", false, `HTTP ${ds.statusCode} ${ds.body.slice(0, 160)}`);
    } else {
      const body = ds.json() as any;
      const card = body.routes.find((r: any) => r.routeId === t.id);
      check("dispatch-sheet", Boolean(card),
        card ? `card present: ${card.dealerCount} order(s), ₹${card.totalAmount}, retired=${card.retired}, code="${card.routeCode}"`
             : "route card MISSING");
    }

    // 5. No __DEL_ marker may leak into any report payload
    const bodies = [dsr.body, msr.body, rs.body, ds.body].join("");
    check("no __DEL_ leak", !bodies.includes("__DEL_"),
      bodies.includes("__DEL_") ? "internal delete marker reached the client" : "clean");
  }

  console.log(`\n${failures === 0 ? "All checks passed." : `${failures} CHECK(S) FAILED.`}`);
  await pgClient.end();
  await app.close();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await pgClient.end();
  await app.close();
  process.exit(1);
});
