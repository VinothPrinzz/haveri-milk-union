// Did migration 0063 touch historical stock data?
//
//  1. Were any fgs_stock_log rows for dates BEFORE the cutover written to?
//     (updated_at newer than the migration would prove a write.)
//  2. Independently of storage: does the Stock Entry screen now SHOW different
//     numbers for a past date than the row actually stores?
import { pgClient } from "./lib/db.js";

async function main() {
  const [{ d: today }] = await pgClient`
    SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS d
  ` as any[];
  console.log("cutover date (today):", today, "\n");

  // 1. Any historical row physically written since the migration ran?
  const touched = await pgClient`
    SELECT date::text AS d, count(*)::int AS rows,
           max(updated_at)::text AS last_write
      FROM fgs_stock_log
     WHERE date < ${today}::date
       AND updated_at > (now() - interval '6 hours')
     GROUP BY 1 ORDER BY 1 DESC
  `;
  console.log("── historical rows WRITTEN in the last 6h (migration window) ──");
  if (!touched.length) console.log("  none — no row before today was modified");
  for (const r of touched as any[]) console.log(`  ${r.d}: ${r.rows} rows, last write ${r.last_write}`);

  // Newest updated_at per date, to show history is untouched.
  const ages = await pgClient`
    SELECT date::text AS d, count(*)::int AS rows,
           max(updated_at)::text AS newest_write
      FROM fgs_stock_log
     WHERE date >= ${today}::date - 6
     GROUP BY 1 ORDER BY 1 DESC
  `;
  console.log("\n── newest write timestamp per date (last 7 days) ──");
  for (const r of ages as any[]) console.log(`  ${r.d}: ${r.rows} rows, newest ${r.newest_write}`);

  // 2. Stored vs what the screen now renders, for each recent past date.
  console.log("\n── STORED row vs what Stock Entry now DISPLAYS, per past date ──");
  for (let back = 1; back <= 5; back++) {
    const [{ d }] = await pgClient`
      SELECT ((now() AT TIME ZONE 'Asia/Kolkata')::date - ${back}::int)::text AS d
    ` as any[];
    const [agg] = await pgClient`
      SELECT count(*)::int AS rows,
             count(*) FILTER (WHERE f.opening    IS DISTINCT FROM fd.opening)::int    AS opening_diff,
             count(*) FILTER (WHERE f.dispatched IS DISTINCT FROM fd.dispatched)::int AS disp_diff,
             count(*) FILTER (WHERE f.closing    IS DISTINCT FROM fd.closing)::int    AS closing_diff,
             COALESCE(sum(f.opening), 0)::int  AS stored_open,
             COALESCE(sum(fd.opening), 0)::int AS shown_open,
             COALESCE(sum(f.closing), 0)::int  AS stored_close,
             COALESCE(sum(fd.closing), 0)::int AS shown_close
        FROM fgs_stock_log f
        JOIN fgs_day(${d}::date) fd ON fd.product_id = f.product_id
       WHERE f.date = ${d}::date
    ` as any[];
    console.log(
      `  ${d}  rows=${agg.rows}  differing: opening=${agg.opening_diff} dispatched=${agg.disp_diff} closing=${agg.closing_diff}` +
      `   | stored open/close = ${agg.stored_open}/${agg.stored_close}   shown = ${agg.shown_open}/${agg.shown_close}`
    );
  }

  // 3. Today's opening vs yesterday's STORED closing — what was actually asked for.
  const [{ y }] = await pgClient`
    SELECT ((now() AT TIME ZONE 'Asia/Kolkata')::date - 1)::text AS y
  ` as any[];
  const [carry] = await pgClient`
    SELECT count(*)::int AS products,
           count(*) FILTER (WHERE f.opening = prev.closing)::int AS matches_prev_stored_closing,
           count(*) FILTER (WHERE prev.closing IS NULL)::int     AS no_row_yesterday
      FROM fgs_stock_log f
      LEFT JOIN fgs_stock_log prev
             ON prev.product_id = f.product_id AND prev.date = ${y}::date
     WHERE f.date = ${today}::date
  ` as any[];
  console.log(`\n── today's stored opening vs YESTERDAY's stored closing ──`);
  console.log(`  today's rows: ${carry.products}`);
  console.log(`  equal to yesterday's stored closing: ${carry.matches_prev_stored_closing}`);
  console.log(`  no row for yesterday at all:         ${carry.no_row_yesterday}`);

  await pgClient.end();
}

main().catch(async (e) => { console.error(e); await pgClient.end(); process.exit(1); });
