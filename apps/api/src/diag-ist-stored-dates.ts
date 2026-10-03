// READ ONLY. Every STORED date column that could have been stamped from a
// UTC "today". Which rows actually sit on the wrong IST calendar day?
import { pgClient } from "./lib/db.js";

const checks: Array<[string, string, string]> = [
  // table, date column, timestamp column it should agree with
  ["payments",           "received_date",  "created_at"],
  ["cheques",            "received_date",  "created_at"],
  ["dealer_ledger",      "voucher_date",   "created_at"],
  ["direct_sales",       "sale_date",      "created_at"],
  ["orders",             "order_date",     "created_at"],
  ["orders",             "delivery_date",  "created_at"],
  ["employee_orders",    "delivery_date",  "created_at"],
  ["invoices",           "due_date",       "invoice_date"],
  ["stock_receipts",     "date",           "created_at"],
  ["route_assignments",  "date",           "created_at"],
];

console.log("Rows stamped with the UTC day while the IST day had already advanced");
console.log("(created 00:00-05:29 IST AND the date column is exactly one day behind)\n");
console.log("Expected non-zero: route_assignments.date. 360 of those were written");
console.log("by the 05:00 IST dispatch-pregenerate cron before it was fixed, between");
console.log("2026-06-13 and 2026-07-22. 302 already have a correct sibling row on the");
console.log("right date, so they cannot be moved without colliding, and they are inert");
console.log("'pending' scaffolding carrying no vehicle or driver. Left as-is.");
console.log();

// Anything else in the schema pairing a date column with a creation instant,
// so the sweep cannot miss a table nobody thought of.
const extra = (await pgClient`
  SELECT d.table_name AS t, d.column_name AS d
    FROM information_schema.columns d
    JOIN information_schema.columns c
      ON c.table_schema = d.table_schema AND c.table_name = d.table_name
     AND c.column_name = 'created_at'
   WHERE d.table_schema = 'public' AND d.data_type = 'date'
     AND d.table_name NOT LIKE 'orders_%'
   ORDER BY 1, 2
`) as any[];
for (const e of extra) {
  if (!checks.some(([t, dc]) => t === e.t && dc === e.d)) checks.push([e.t, e.d, "created_at"]);
}

for (const [t, dcol, tcol] of checks) {
  const [r] = (await pgClient.unsafe(`
    SELECT count(*)::int AS n,
           count(*) FILTER (
             WHERE ${dcol} = (${tcol} AT TIME ZONE 'Asia/Kolkata')::date - 1
           )::int AS behind
      FROM ${t}
     WHERE ${dcol} IS NOT NULL AND ${tcol} IS NOT NULL
       AND (${tcol} AT TIME ZONE 'Asia/Kolkata')::time < TIME '05:30'
  `)) as any[];
  console.log(`  ${(t + "." + dcol).padEnd(30)} ${String(r.n).padStart(4)} in window, ` +
    `${String(r.behind).padStart(4)} a day behind${Number(r.behind) > 0 ? "   <-- NEEDS BACKFILL" : ""}`);
}

console.log("\n── invoices.due_date: does it match credit terms off the IST invoice day? ──");
const [due] = (await pgClient`
  SELECT count(*)::int AS total,
         count(*) FILTER (
           WHERE due_date <> (invoice_date AT TIME ZONE 'Asia/Kolkata')::date
                             + (due_date - (invoice_date AT TIME ZONE 'UTC')::date)
         )::int AS n
    FROM invoices WHERE due_date IS NOT NULL
`) as any[];
console.log(`  ${due.total} invoices with a due date`);

const [shift] = (await pgClient`
  SELECT count(*)::int AS n
    FROM invoices
   WHERE due_date IS NOT NULL
     AND (invoice_date AT TIME ZONE 'Asia/Kolkata')::date
         <> (invoice_date AT TIME ZONE 'UTC')::date
`) as any[];
console.log(`  ${shift.n} whose IST invoice day differs from their UTC invoice day`);

console.log("\n── the 807 orders created 00:00-05:29 IST: what are they? ──");
const ord = (await pgClient`
  SELECT to_char(o.created_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD HH24:MI') AS "createdIst",
         o.order_date::text AS "orderDate", o.delivery_date::text AS "deliveryDate",
         o.status::text AS status, count(*)::int AS n
    FROM orders o
   WHERE (o.created_at AT TIME ZONE 'Asia/Kolkata')::time < TIME '05:30'
   GROUP BY 1,2,3,4 ORDER BY 1 DESC LIMIT 12
`) as any[];
for (const r of ord) {
  const istDay = r.createdIst.slice(0, 10);
  console.log(`  created ${r.createdIst} IST  order_date=${r.orderDate}  delivery=${r.deliveryDate}  ` +
    `${r.status}  x${r.n}${r.orderDate !== istDay ? "   <-- order_date off the IST day" : ""}`);
}

const [hrs] = (await pgClient`
  SELECT string_agg(x.hr || ':00 (' || x.n || ')', '  ' ORDER BY x.hr) AS s
    FROM (SELECT to_char(created_at AT TIME ZONE 'Asia/Kolkata','HH24') AS hr, count(*)::int AS n
            FROM orders WHERE (created_at AT TIME ZONE 'Asia/Kolkata')::time < TIME '05:30'
           GROUP BY 1) x
`) as any[];
console.log(`\n  by IST hour: ${hrs.s}`);
await pgClient.end();
