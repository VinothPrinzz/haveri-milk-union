// Read-only: what of migration 0063 is actually present in the database?
import { pgClient } from "./lib/db.js";

async function main() {
  const col = await pgClient`
    SELECT column_name FROM information_schema.columns
     WHERE table_name = 'fgs_stock_log' AND column_name = 'opening_manual'
  `;
  console.log("opening_manual column:", col.length ? "PRESENT" : "absent");

  const fns = await pgClient`
    SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname IN ('fgs_day', 'fgs_available')
  `;
  console.log("functions:", (fns as any[]).map(f => `${f.proname}(${f.args})`).join(", ") || "none");

  const idx = await pgClient`
    SELECT indexname FROM pg_indexes
     WHERE tablename = 'fgs_stock_log' AND indexname = 'idx_fgs_stock_product_date_desc'
  `;
  console.log("index:", idx.length ? "PRESENT" : "absent");

  if (col.length) {
    const [b] = await pgClient`
      SELECT count(*)::int AS n FROM fgs_stock_log
       WHERE date = (now() AT TIME ZONE 'Asia/Kolkata')::date AND opening_manual
    ` as any[];
    const [t] = await pgClient`
      SELECT count(*)::int AS n FROM fgs_stock_log
       WHERE date = (now() AT TIME ZONE 'Asia/Kolkata')::date
    ` as any[];
    console.log(`today's rows: ${t.n} total, ${b.n} flagged baseline`);
  }

  await pgClient.end();
}

main().catch(async (e) => { console.error(e); await pgClient.end(); process.exit(1); });
