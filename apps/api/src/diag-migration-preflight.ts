// Read-only pre-flight for migration 0069. Connects DIRECTLY (port 5432),
// not through the pgBouncer transaction pooler, because that is what a
// schema rewrite needs.
import postgres from "postgres";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

const direct = process.env.DATABASE_URL;
if (!direct) throw new Error("DATABASE_URL (direct, :5432) not set");

const sql = postgres(direct, { prepare: false, max: 1, connect_timeout: 15 });

async function main() {
  const [who] = await sql`
    SELECT current_database() AS db,
           inet_server_addr()::text AS host,
           inet_server_port()      AS port,
           now() AT TIME ZONE 'Asia/Kolkata' AS ist,
           version()               AS version
  `;
  console.log(`database : ${who!.db} @ ${who!.host}:${who!.port}`);
  console.log(`IST now  : ${new Date(who!.ist).toISOString().replace("T", " ").slice(0, 19)}`);
  console.log(`server   : ${String(who!.version).split(" ").slice(0, 2).join(" ")}`);

  // Is this a primary, and does anything stream from it?
  const [rec] = await sql`SELECT pg_is_in_recovery() AS in_recovery`;
  const reps = await sql`SELECT application_name, state FROM pg_stat_replication`;
  console.log(`in recovery (standby): ${rec!.in_recovery}`);
  console.log(`replicas streaming   : ${reps.length ? reps.map((r) => `${r.application_name}(${r.state})`).join(", ") : "none"}`);

  // How much data has to be rewritten, and is anything live right now?
  const sizes = await sql<{ tbl: string; rows: number; bytes: string }[]>`
    SELECT c.relname AS tbl,
           COALESCE(s.n_live_tup, 0)::int AS rows,
           pg_size_pretty(pg_total_relation_size(c.oid)) AS bytes
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r','p')
       AND c.relname IN (
         'orders','order_items','invoices','payments','dealer_ledger',
         'direct_sales','direct_sale_items','employee_orders','employee_order_items',
         'products','razorpay_payments','dealer_wallets','dealers'
       )
     ORDER BY pg_total_relation_size(c.oid) DESC
  `;
  console.log("\nlargest tables to be rewritten:");
  for (const s of sizes) console.log(`   ${s.tbl.padEnd(22)} ${String(s.rows).padStart(8)} rows  ${s.bytes}`);

  const [act] = await sql`
    SELECT COUNT(*) FILTER (WHERE state = 'active'  AND pid <> pg_backend_pid())::int AS active,
           COUNT(*) FILTER (WHERE state = 'idle in transaction')::int                 AS idle_in_txn
      FROM pg_stat_activity WHERE datname = current_database()
  `;
  console.log(`\nlive sessions: ${act!.active} active, ${act!.idle_in_txn} idle-in-transaction`);
  if (act!.idle_in_txn > 0)
    console.log("   ⚠ idle-in-transaction sessions can block an ACCESS EXCLUSIVE lock");

  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
