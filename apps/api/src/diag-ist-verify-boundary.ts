// READ ONLY. Proves the day now runs 00:00:00 to 23:59:59 IST, using the
// exact expressions the routes were rewritten to use.
import { pgClient } from "./lib/db.js";

console.log("── 1. the boundary itself ──");
const b = (await pgClient`
  SELECT * FROM (VALUES
    ('7th 23:59:58 IST', '2026-09-07 18:29:58+00'::timestamptz),
    ('7th 23:59:59 IST', '2026-09-07 18:29:59+00'::timestamptz),
    ('8th 00:00:00 IST', '2026-09-07 18:30:00+00'::timestamptz),
    ('8th 00:00:01 IST', '2026-09-07 18:30:01+00'::timestamptz),
    ('8th 02:00:00 IST', '2026-09-07 20:30:00+00'::timestamptz),
    ('8th 05:29:59 IST', '2026-09-07 23:59:59+00'::timestamptz),
    ('8th 05:30:00 IST', '2026-09-08 00:00:00+00'::timestamptz)
  ) AS t(label, ts)
`) as any[];
for (const r of b) {
  const [x] = (await pgClient`
    SELECT (${r.ts}::timestamptz AT TIME ZONE 'Asia/Kolkata')::date::text AS fixed,
           (${r.ts}::timestamptz)::date::text                             AS old
  `) as any[];
  const changed = x.fixed !== x.old;
  console.log(`  ${r.label}  ->  ${x.fixed}   (was ${x.old})${changed ? "   <-- was a day behind" : ""}`);
}

console.log("\n── 2. Finance Dashboard \"Collected today\", simulated at 02:00 IST on the 8th ──");
const IST_DAY = "2026-09-08", UTC_DAY = "2026-09-07";
const [d] = (await pgClient`
  SELECT COALESCE(SUM(amount) FILTER (WHERE received_date = ${UTC_DAY}::date), 0)::float8 AS "before",
         COALESCE(SUM(amount) FILTER (WHERE received_date = ${IST_DAY}::date), 0)::float8 AS "after"
    FROM payments
`) as any[];
console.log(`  before (received_date = CURRENT_DATE) : Rs.${d.before.toFixed(2)}  <- the 7th's money, labelled "today"`);
console.log(`  after  (received_date = IST today)    : Rs.${d.after.toFixed(2)}  <- the 8th, correctly empty at 02:00`);

console.log("\n── 3. the two receipts actually taken before 05:30 IST ──");
const gap = (await pgClient`
  SELECT p.received_date::text AS booked,
         to_char(p.created_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD HH24:MI') AS "istMoment",
         (p.created_at AT TIME ZONE 'Asia/Kolkata')::date::text AS "istDay",
         (p.created_at)::date::text                             AS "utcDay",
         p.amount::float8 AS amount, d.code AS dealer
    FROM payments p JOIN dealers d ON d.id = p.dealer_id
   WHERE (p.created_at AT TIME ZONE 'Asia/Kolkata')::time < TIME '05:30'
   ORDER BY p.created_at
`) as any[];
for (const r of gap) {
  console.log(`  Rs.${String(r.amount).padEnd(7)} ${r.dealer.padEnd(5)} taken ${r.istMoment} IST`);
  console.log(`      stored received_date = ${r.booked}   IST day = ${r.istDay}   ` +
    `(a UTC ::date would have said ${r.utcDay})`);
  console.log(`      stored date correct: ${r.booked === r.istDay}; ` +
    `now also REPORTED on ${r.istDay} instead of ${r.utcDay}`);
}

console.log("\n── 4. Razorpay \"collected today\" now keys on the IST day ──");
const [g] = (await pgClient`
  SELECT COALESCE(SUM(CASE WHEN status='paid' AND (paid_at AT TIME ZONE 'Asia/Kolkata')::date = ist.d
                      THEN amount - amount_refunded ELSE 0 END), 0)::float8 AS today
    FROM razorpay_payments,
         LATERAL (SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date AS d) ist
`) as any[];
console.log(`  collected so far on the current IST day: Rs.${g.today.toFixed(2)}`);
await pgClient.end();
