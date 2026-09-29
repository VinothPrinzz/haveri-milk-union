// ═══════════════════════════════════════════════════════════════════════
// diag-verify-adhoc-sheets.ts — VERIFY (read-only; injects HTTP requests).
//
// Proves the two changed reads actually return the no-route ("ADHOC") bucket
// against production data:
//   • GET /api/v1/reports/route-sheet  — extra ADHOC page for cash / VIP /
//     employee ghee subsidy sales that named no route
//   • GET /api/v1/dispatch-sheet       — same bucket as a card, plus routed
//     adhoc sales folded into their route's card
//
// Boots the real Fastify app and uses app.inject (no port traffic), reusing an
// existing non-expired admin session so nothing is written.
//
// USAGE (from apps/api):  npx tsx src/diag-verify-adhoc-sheets.ts
// ═══════════════════════════════════════════════════════════════════════

import { pgClient } from "./lib/db.js";
import app from "./server.js";

// Dates chosen from the data: 08-01 = 5 route-less employee subsidy sales,
// 06-20 = routed agent gate pass + route-less VIP sample, 04-20 = cash sale.
// 2026-05-16 has an adhoc sale but no dealer orders — the "no real routes at
// all" path, where the sentinel is the only entry in the route array.
const DATES = ["2026-08-01", "2026-05-16", "2026-06-23"];

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
  console.log(`Borrowed session of ${sess.name} (${sess.role})\n`);
  const headers = { "x-session-token": sess.token as string };

  for (const date of DATES) {
    console.log(`══════════ ${date} ══════════`);

    const rs = await app.inject({
      method: "GET",
      url: `/api/v1/reports/route-sheet?date=${date}`,
      headers,
    });
    if (rs.statusCode !== 200) {
      console.log(`  route-sheet → HTTP ${rs.statusCode} ${rs.body.slice(0, 200)}`);
    } else {
      const body = rs.json() as any;
      console.log(`  route-sheet: ${body.routes.length} page(s)`);
      for (const r of body.routes) {
        const mark = r.isAdhoc ? "  ← ADHOC" : "";
        console.log(`    ${r.code.padEnd(6)} ${String(r.name).padEnd(34)} rows=${r.customers.length} pkts=${r.totals.totalAllQty}${mark}`);
        if (r.isAdhoc) {
          for (const c of r.customers) {
            console.log(`        [${c.tag ?? "—"}] ${c.name} · others="${c.othersText}" · ₹${c.netAmount}`);
          }
          for (const i of r.abstract.items) {
            console.log(`        abstract: ${i.alias} → ${i.packets} pkt, ₹${i.amount}`);
          }
        }
      }
    }

    const ds = await app.inject({
      method: "GET",
      url: `/api/v1/dispatch-sheet?date=${date}`,
      headers,
    });
    if (ds.statusCode !== 200) {
      console.log(`  dispatch-sheet → HTTP ${ds.statusCode} ${ds.body.slice(0, 200)}`);
    } else {
      const body = ds.json() as any;
      console.log(`  dispatch-sheet: ${body.routes.length} card(s)`);
      for (const r of body.routes) {
        const mark = r.isAdhoc ? "  ← ADHOC" : "";
        const adhoc = (r.adhoc ?? [])
          .map((a: any) => `${a.label} ${a.packets}pkt/${a.sales}`)
          .join(", ");
        console.log(`    ${r.routeCode.padEnd(6)} ${String(r.routeName).padEnd(34)} items=${r.items.length} pkts=${r.totals.packets}${mark}`);
        if (adhoc) console.log(`        adhoc: ${adhoc}`);
      }
    }
    console.log();
  }

  // Route filter must NOT surface the adhoc bucket (the caller asked for one
  // real route), and a batch filter must not drag in batch-less adhoc rows.
  const [aRoute] = await pgClient`SELECT id, code FROM routes WHERE deleted_at IS NULL ORDER BY code LIMIT 1`;
  const [aBatch] = await pgClient`SELECT id, name FROM batches WHERE deleted_at IS NULL LIMIT 1`;
  console.log("══════════ filter guards (2026-08-01) ══════════");
  for (const [label, qs] of [
    ["routeId=" + aRoute!.code, `date=2026-08-01&routeId=${aRoute!.id}`],
    ["batchId=" + aBatch!.name, `date=2026-08-01&batchId=${aBatch!.id}`],
  ] as const) {
    const r1 = await app.inject({ method: "GET", url: `/api/v1/reports/route-sheet?${qs}`, headers });
    const r2 = await app.inject({ method: "GET", url: `/api/v1/dispatch-sheet?${qs}`, headers });
    const rsAdhoc = r1.statusCode === 200 && (r1.json() as any).routes.some((r: any) => r.isAdhoc);
    const dsAdhoc = r2.statusCode === 200 && (r2.json() as any).routes.some((r: any) => r.isAdhoc);
    console.log(`  ${label}: route-sheet adhoc page = ${rsAdhoc}, dispatch adhoc card = ${dsAdhoc}`);
  }

  await pgClient.end();
  await app.close();
}

main().catch(async e => {
  console.error(e);
  try { await pgClient.end(); await app.close(); } catch {}
  process.exit(1);
});
