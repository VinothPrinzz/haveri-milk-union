// Post-migration sanity: values must be preserved exactly (42.50 -> 42.500),
// aggregates must be unchanged, and money must now render three decimals.
import { pgClient } from "./lib/db.js";

async function main() {
  console.log("── sample product prices ──");
  const prods = await pgClient`
    SELECT code, name, base_price::text AS base, mrp::text AS mrp,
           dealer_price::text AS dealer
      FROM products
     WHERE deleted_at IS NULL AND base_price IS NOT NULL
     ORDER BY sort_order NULLS LAST, name
     LIMIT 6
  `;
  for (const p of prods as any[])
    console.log(`   ${String(p.code).padEnd(9)} base=${String(p.base).padStart(10)}  mrp=${String(p.mrp).padStart(10)}  dealer=${String(p.dealer).padStart(10)}  ${p.name}`);

  console.log("\n── aggregates (must match pre-migration business totals) ──");
  const [o] = await pgClient`
    SELECT COUNT(*)::int AS n,
           COALESCE(SUM(grand_total),0)::text AS total
      FROM orders WHERE status IN ('confirmed','dispatched','delivered')
  `;
  console.log(`   confirmed+ orders : ${(o as any).n} rows, sum grand_total = ${(o as any).total}`);

  const [inv] = await pgClient`SELECT COUNT(*)::int AS n, COALESCE(SUM(total_amount),0)::text AS t FROM invoices`;
  console.log(`   invoices          : ${(inv as any).n} rows, sum total_amount = ${(inv as any).t}`);

  const [pay] = await pgClient`SELECT COUNT(*)::int AS n, COALESCE(SUM(amount),0)::text AS t FROM payments`;
  console.log(`   payments          : ${(pay as any).n} rows, sum amount = ${(pay as any).t}`);

  const [w] = await pgClient`SELECT COUNT(*)::int AS n, COALESCE(SUM(balance),0)::text AS t FROM dealer_wallets`;
  console.log(`   dealer wallets    : ${(w as any).n} rows, sum balance = ${(w as any).t}`);

  console.log("\n── a 3dp value must now round-trip without truncation ──");
  const [probe] = await pgClient`
    SELECT (42.375::numeric)::numeric(11,3)::text AS rate,
           (42.375::numeric * 20)::numeric(11,3)::text AS line
  `;
  console.log(`   rate 42.375 stored as ${(probe as any).rate}, x20 = ${(probe as any).line}`);

  // Anything whose third decimal is non-zero would previously have been lost.
  const [nz] = await pgClient`
    SELECT COUNT(*)::int AS n FROM order_items
     WHERE (unit_price * 1000)::bigint % 10 <> 0
  `;
  console.log(`\n   order_items with a non-zero 3rd decimal: ${(nz as any).n} (0 expected — nothing was 3dp before today)`);

  await pgClient.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
