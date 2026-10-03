// READ ONLY. Which price-master rows still carry a third decimal, and what
// resolveUnitPrice()'s round2 does to each one.
import { pgClient } from "./lib/db.js";
const rows = (await pgClient`
  SELECT code, name, gst_percent::numeric AS gst,
         base_price::numeric   AS base,
         dealer_price::numeric AS dealer,
         available
  FROM products
  WHERE deleted_at IS NULL
    AND base_price IS NOT NULL
    AND (base_price::numeric * 1000)::bigint % 10 <> 0
  ORDER BY code
`) as any[];
console.log(`${rows.length} live product(s) still hold a 3-decimal base_price.\n`);
let harmful = 0;
for (const r of rows) {
  const gstF = 1 + Number(r.gst) / 100;
  const stored = Number(r.base);
  const rounded = Math.round(stored * 100) / 100;          // what resolveUnitPrice writes
  const grossStored  = Math.round(stored  * gstF * 100) / 100;
  const grossRounded = Math.round(rounded * gstF * 100) / 100;
  const chart = r.dealer == null ? null : Number(r.dealer);
  const correct = chart == null ? null : Math.round(chart / gstF * 100) / 100;
  const bad = grossStored !== grossRounded;
  if (bad) harmful++;
  console.log(
    `${bad ? "!!" : "  "} ${r.code} ${r.name}  gst ${Number(r.gst)}%  ` +
    `base ${stored} -> billed net ${rounded}  ` +
    `gross ${grossStored.toFixed(2)} -> ${grossRounded.toFixed(2)}` +
    (chart != null ? `  chart ${chart.toFixed(2)}, correct net ${correct!.toFixed(2)}` : "  (no chart price)") +
    (r.available ? "" : "  [not available]"));
}
console.log(`\n${harmful} of them shift the GROSS by a paisa when rounded.`);
await pgClient.end();
