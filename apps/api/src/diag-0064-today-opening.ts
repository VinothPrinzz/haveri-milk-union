// Is today's opening actually "the previous entry's closing" for every product?
// Breaks the 174 baseline rows down by where their opening came from.
import { pgClient } from "./lib/db.js";

async function main() {
  const [{ d: today }] = await pgClient`
    SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS d
  ` as any[];

  const rows = await pgClient`
    SELECT p.code, p.name,
           f.opening                            AS today_opening,
           prev.date::text                      AS prev_date,
           prev.closing                         AS prev_stored_closing,
           (${today}::date - prev.date)::int    AS gap_days,
           f.created_at > (now() - interval '12 hours') AS row_created_by_migration
      FROM fgs_stock_log f
      JOIN products p ON p.id = f.product_id
      LEFT JOIN LATERAL (
        SELECT p2.date, p2.closing FROM fgs_stock_log p2
         WHERE p2.product_id = f.product_id AND p2.date < ${today}::date
         ORDER BY p2.date DESC LIMIT 1
      ) prev ON true
     WHERE f.date = ${today}::date
  `;

  let matches = 0, noHistory = 0;
  const mismatches: any[] = [];
  for (const r of rows as any[]) {
    if (r.prev_stored_closing === null) { noHistory++; continue; }
    if (Number(r.today_opening) === Number(r.prev_stored_closing)) matches++;
    else mismatches.push(r);
  }

  console.log(`today's baseline rows: ${rows.length}`);
  console.log(`  opening == previous entry's stored closing: ${matches}`);
  console.log(`  no prior entry at all (opening 0):          ${noHistory}`);
  console.log(`  MISMATCHED:                                 ${mismatches.length}`);

  if (mismatches.length) {
    console.log("\nmismatches — these kept an opening typed by the operator TODAY,");
    console.log("because the baseline preserved an existing row rather than overwriting it:\n");
    console.log("code      typed   prevClosing  prevDate     gap  name");
    for (const m of mismatches) {
      console.log(
        `${String(m.code).padEnd(9)} ${String(m.today_opening).padStart(6)} ${String(m.prev_stored_closing).padStart(12)}  ${m.prev_date}  ${String(m.gap_days).padStart(3)}  ${m.name}`
      );
    }
    const delta = mismatches.reduce(
      (s, m) => s + (Number(m.prev_stored_closing) - Number(m.today_opening)), 0
    );
    console.log(`\nif these were re-based to the previous closing, total stock would change by ${delta > 0 ? "+" : ""}${delta} units`);
  }

  // How far back each baseline reached.
  const gaps = await pgClient`
    SELECT count(*) FILTER (WHERE g.gap = 1)::int            AS from_yesterday,
           count(*) FILTER (WHERE g.gap BETWEEN 2 AND 7)::int AS from_2_7d,
           count(*) FILTER (WHERE g.gap > 7)::int             AS older_than_7d,
           count(*) FILTER (WHERE g.gap IS NULL)::int         AS no_history
      FROM (
        SELECT (${today}::date - (
                 SELECT max(p2.date) FROM fgs_stock_log p2
                  WHERE p2.product_id = f.product_id AND p2.date < ${today}::date
               ))::int AS gap
          FROM fgs_stock_log f WHERE f.date = ${today}::date
      ) g
  `;
  console.log("\nwhere each baseline's opening was carried from:", gaps[0]);

  await pgClient.end();
}

main().catch(async (e) => { console.error(e); await pgClient.end(); process.exit(1); });
