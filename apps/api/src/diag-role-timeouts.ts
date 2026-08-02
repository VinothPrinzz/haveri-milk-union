// Read-only: who are we connecting as, and what are the session timeouts?
// Through Supabase's TRANSACTION pooler, per-session SET does not survive
// between transactions, so these have to be set at ROLE level to stick.
import { pgClient } from "./lib/db.js";

async function main() {
  const [who] = await pgClient`
    SELECT current_user                                            AS current_user,
           session_user                                            AS session_user,
           current_setting('statement_timeout')                    AS statement_timeout,
           current_setting('idle_in_transaction_session_timeout')  AS idle_in_txn,
           current_setting('lock_timeout')                         AS lock_timeout,
           current_setting('max_connections')                      AS max_connections,
           version()                                               AS version
  `;
  console.log(who);

  console.log("\n=== Existing per-role settings (pg_db_role_setting) ===");
  const roleSettings = await pgClient`
    SELECT COALESCE(r.rolname, '<all roles>') AS role,
           COALESCE(d.datname, '<all dbs>')   AS database,
           s.setconfig
      FROM pg_db_role_setting s
      LEFT JOIN pg_roles    r ON r.oid = s.setrole
      LEFT JOIN pg_database d ON d.oid = s.setdatabase
  `;
  console.table(roleSettings);

  console.log("\n=== Can this role ALTER ROLE itself? ===");
  const [priv] = await pgClient`
    SELECT rolsuper, rolcreaterole, rolname
      FROM pg_roles WHERE rolname = current_user
  `;
  console.log(priv);

  await pgClient.end();
}

main().catch(async (e) => {
  console.error(e);
  await pgClient.end();
  process.exit(1);
});
