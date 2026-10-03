// Read-only: which soft-deleted dealers still carry statement history, and
// does Dealer Statements reach them. Lists every deleted dealer that has
// history (and on which rails), then times the picker's "has history" rule
// and loads each one's full statement through loadStatement().
//
//   npx tsx apps/api/src/diag-deleted-dealer-history.ts
import { pgClient } from "./lib/db.js";
import { loadStatement } from "./routes/finance-dealer-statements.js";
import { istToday } from "./lib/ist-date.js";

const rows = await pgClient`
  SELECT d.id, d.name, d.code, d.deleted_at::date AS deleted_on,
         (SELECT count(*) FROM orders o WHERE o.dealer_id = d.id
            AND o.status IN ('confirmed','dispatched','delivered'))::int AS orders,
         (SELECT count(*) FROM payments p WHERE p.dealer_id = d.id)::int AS payments,
         (SELECT count(*) FROM dealer_ledger l WHERE l.dealer_id = d.id)::int AS ledger,
         (SELECT count(*) FROM direct_sales ds WHERE ds.customer_type = 'agent'
            AND ds.customer_id = d.id)::int AS gate_passes,
         (SELECT count(*) FROM razorpay_refunds rf WHERE rf.dealer_id = d.id
            AND rf.status = 'processed')::int AS refunds,
         COALESCE(d.opening_balance, 0)::float8 AS opening
    FROM dealers d
   WHERE d.deleted_at IS NOT NULL
   ORDER BY d.deleted_at DESC
`;

const withHistory = (rows as any[]).filter(
  (r) => r.orders + r.payments + r.ledger + r.gate_passes + r.refunds > 0 || r.opening !== 0
);
for (const r of withHistory) {
  console.log(
    `${String(r.deleted_on).slice(0, 10)}  ${String(r.name).padEnd(28).slice(0, 28)}  ` +
    `ord=${r.orders} pay=${r.payments} led=${r.ledger} gp=${r.gate_passes} rf=${r.refunds} ob=${r.opening}`
  );
}
console.log(`${rows.length} deleted dealers, ${withHistory.length} with statement history\n`);

// The picker's rule, timed. Must list exactly the dealers above.
const t0 = Date.now();
const picker = await pgClient`
  SELECT d.id, d.deleted_at IS NOT NULL AS deleted
    FROM dealers d
   WHERE (d.deleted_at IS NULL
          OR COALESCE(d.opening_balance, 0) <> 0
          OR EXISTS (SELECT 1 FROM orders o2
                      WHERE o2.dealer_id = d.id
                        AND o2.status IN ('confirmed', 'dispatched', 'delivered'))
          OR EXISTS (SELECT 1 FROM payments p2 WHERE p2.dealer_id = d.id)
          OR EXISTS (SELECT 1 FROM dealer_ledger dl2 WHERE dl2.dealer_id = d.id)
          OR EXISTS (SELECT 1 FROM direct_sales ds2
                      WHERE ds2.customer_type = 'agent' AND ds2.customer_id = d.id)
          OR EXISTS (SELECT 1 FROM razorpay_refunds rf2
                      WHERE rf2.dealer_id = d.id AND rf2.status = 'processed'))
     AND NOT EXISTS (SELECT 1 FROM routes demo_rt
                      WHERE demo_rt.code = 'DEMO' AND demo_rt.id = d.route_id)
`;
const pickedDeleted = new Set((picker as any[]).filter((r) => r.deleted).map((r) => r.id));
console.log(
  `picker: ${picker.length} dealers (${pickedDeleted.size} deleted) in ${Date.now() - t0} ms`
);
const missing = withHistory.filter((r) => !pickedDeleted.has(r.id));
console.log(missing.length ? `MISSING from picker: ${missing.map((r) => r.name).join(", ")}` : "picker lists every deleted dealer with history");

// Full statement for each, whole history to today.
for (const r of withHistory) {
  const s = await loadStatement(r.id, "2026-06-01", istToday());
  const d: any = s?.dealer;
  console.log(
    `\n${d?.name}  code=${d?.code ?? "null"}  deletedOn=${d?.deletedOn}  phone=${d?.phone}\n` +
    `  rows=${s?.rows.length}  billed=${s?.totals.invoices.toFixed(2)}  ` +
    `received=${((s?.totals.payments ?? 0) + (s?.totals.topups ?? 0)).toFixed(2)}  ` +
    `closing=${s?.totals.closingBalance.toFixed(2)}`
  );
}
await pgClient.end();
