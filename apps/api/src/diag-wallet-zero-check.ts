// Read-only: is "sum(dealer_wallets.balance) = 0" pre-existing state or
// something the 0069 rewrite caused? A numeric scale widening cannot zero
// a value, but confirm directly rather than argue from first principles.
import { pgClient } from "./lib/db.js";

async function main() {
  const [a] = await pgClient`
    SELECT COUNT(*)::int AS n,
           COUNT(*) FILTER (WHERE balance <> 0)::int          AS nonzero,
           COUNT(*) FILTER (WHERE last_topup_amount IS NOT NULL)::int AS ever_topped,
           COALESCE(MAX(balance), 0)::text AS max_bal,
           COALESCE(MIN(balance), 0)::text AS min_bal
      FROM dealer_wallets
  `;
  console.log("dealer_wallets:", JSON.stringify(a));

  const [l] = await pgClient`
    SELECT COUNT(*)::int AS n, COALESCE(SUM(amount), 0)::text AS t FROM dealer_ledger
  `;
  console.log("dealer_ledger :", JSON.stringify(l));

  await pgClient.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
