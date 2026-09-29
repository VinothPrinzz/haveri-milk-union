import { pgClient } from "./lib/db.js";
const ID = "0eb87cf2-1e7c-482e-9972-03be8aa7dfed";
async function main() {
  const [o] = await pgClient`
    SELECT o.payment_mode::text AS pm, o.payment_reference, o.status::text AS st,
           o.updated_at, o.grand_total::text AS total
      FROM orders o WHERE o.id = ${ID}::uuid
  ` as any[];
  console.log("orders.payment_mode   =", o.pm);
  console.log("orders.payment_reference =", o.payment_reference);
  console.log("status =", o.st, " grand_total =", o.total);
  console.log("updated_at =", o.updated_at, "  (unchanged since dispatch 2026-09-01 16:39)");
  await pgClient.end();
}
main().catch(async (e) => { console.error(e); await pgClient.end(); process.exit(1); });
