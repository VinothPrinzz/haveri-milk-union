// ═══════════════════════════════════════════════════════════════════════
// diag-verify-invoice-taluka.ts — renders one real order invoice and one
// real direct-sale invoice in memory (nothing is stored, nothing uploaded)
// to prove the buyer address line still builds after the district became a
// constant and the taluka was added ahead of it.
//
// USAGE (from apps/api):  npx tsx src/diag-verify-invoice-taluka.ts
// ═══════════════════════════════════════════════════════════════════════
import { pgClient } from "./lib/db.js";
import { generateInvoicePdfSync, generateDirectSaleInvoicePdfSync } from "./lib/invoice-pdf.js";

const [order] = await pgClient`
  SELECT o.id, d.name, d.city, z.name AS taluka
    FROM orders o
    JOIN dealers d ON d.id = o.dealer_id
    LEFT JOIN zones z ON z.id = d.zone_id
   WHERE o.status IN ('confirmed', 'dispatched', 'delivered')
   ORDER BY o.created_at DESC
   LIMIT 1
`;
if (order) {
  const pdf = await generateInvoicePdfSync(order.id);
  console.log("order invoice:", order.name, "|", order.taluka, order.city,
              "| bytes:", (pdf as any)?.pdfBytes?.length ?? (pdf as any)?.length ?? "(ok)");
} else {
  console.log("no confirmed order found");
}

const [sale] = await pgClient`
  SELECT ds.id, d.name, d.city, z.name AS taluka
    FROM direct_sales ds
    LEFT JOIN dealers d ON d.id = ds.customer_id AND ds.customer_type = 'agent'
    LEFT JOIN zones z ON z.id = d.zone_id
   WHERE ds.status = 'confirmed' AND ds.grand_total > 0
   ORDER BY ds.created_at DESC
   LIMIT 1
`;
if (sale) {
  const pdf = await generateDirectSaleInvoicePdfSync(sale.id);
  console.log("direct-sale invoice:", sale.name ?? "(counter)", "|", sale.taluka, sale.city,
              "| bytes:", (pdf as any)?.pdfBytes?.length ?? (pdf as any)?.length ?? "(ok)");
} else {
  console.log("no confirmed direct sale found");
}

await pgClient.end();
