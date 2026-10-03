// One-off: give the `postgres` role an idle-in-transaction timeout.
//
// It was 0 (disabled), so a transaction that opened and then stopped making
// progress held its connection — and any row locks it had taken — forever.
// Through Supabase's TRANSACTION pooler a per-session SET does not survive
// between transactions, so this has to live at ROLE level to stick.
//
// 60s matches what Supabase itself sets for supabase_auth_admin. Every
// transaction in this codebase is DB-only (no HTTP inside sql.begin), so real
// idle-in-transaction gaps are milliseconds — this only ever fires on a leak.
//
// Takes effect on NEW server connections; existing pooled ones keep the old
// value until recycled.
import { pgClient } from "./lib/db.js";

async function main() {
  console.log("before:", await pgClient`
    SELECT setconfig FROM pg_db_role_setting s
      JOIN pg_roles r ON r.oid = s.setrole WHERE r.rolname = 'postgres'
  `);

  await pgClient.unsafe(
    `ALTER ROLE postgres SET idle_in_transaction_session_timeout = '60s'`
  );

  console.log("after: ", await pgClient`
    SELECT setconfig FROM pg_db_role_setting s
      JOIN pg_roles r ON r.oid = s.setrole WHERE r.rolname = 'postgres'
  `);

  await pgClient.end();
}

main().catch(async (e) => {
  console.error(e);
  await pgClient.end();
  process.exit(1);
});
