// apps/api/src/lib/reprice-drafts.ts
// ════════════════════════════════════════════════════════════════════
// Bring open standing-indent drafts onto a product's current price.
//
// A draft copies each product's price when it is created (nightly, for
// the next day — worker/jobs/materialize-drafts.ts), and auto-confirm
// confirms it at that stored total. So a price change made after the
// draft was built never reached it: the dealer was billed the old rate.
//
// Only status 'draft' with a delivery date of today or later is touched.
// Anything further along (payment_required, confirmed) has been shown to
// the dealer as a payable amount or posted to the ledger, and keeps the
// price it was placed at.
// ════════════════════════════════════════════════════════════════════
import { pgClient } from "./db.js";
import { istToday } from "./ist-date.js";
import { resolveUnitPrice } from "./rate-price.js";
import { calcLine } from "./line-totals.js";

/** Re-prices this product's lines on open drafts. Returns drafts changed. */
export async function repriceOpenDrafts(
  tx: typeof pgClient,
  productId: string,
): Promise<number> {
  const [p] = await tx`
    SELECT p.base_price::text  AS "basePrice",
           p.mrp::text         AS mrp,
           p.gst_percent::text AS "gstPercent",
           p.code              AS code,
           c.name              AS "categoryName"
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.id = ${productId}
  `;
  if (!p) return 0;

  const lines = await tx`
    SELECT oi.id, oi.order_id, oi.quantity, oi.unit_price::text AS unit_price,
           oi.gst_percent::text AS gst_percent,
           d.rate_category::text AS rate_category
      FROM order_items oi
      JOIN orders o  ON o.id = oi.order_id
      JOIN dealers d ON d.id = o.dealer_id
     WHERE oi.product_id = ${productId}
       AND o.status = 'draft'
       AND o.delivery_date >= ${istToday()}::date
     FOR UPDATE OF oi, o
  `;

  const gstPct = parseFloat(p.gstPercent);
  // Sent as one JSON value: the driver can't bind plain JS arrays here.
  const rows: { id: string; unit_price: string; gst_amount: string; line_total: string }[] = [];
  const orderIds = new Set<string>();

  for (const ln of lines) {
    const price = resolveUnitPrice(p as any, ln.rate_category);
    const priceSame = Math.round(price * 100) === Math.round(parseFloat(ln.unit_price) * 100);
    const gstSame = parseFloat(ln.gst_percent) === gstPct;
    if (priceSame && gstSame) continue;
    const t = calcLine(price, gstPct, ln.quantity);
    rows.push({
      id: ln.id,
      unit_price: price.toFixed(2),
      gst_amount: t.gst.toFixed(2),
      line_total: t.total.toFixed(2),
    });
    orderIds.add(ln.order_id);
  }
  if (rows.length === 0) return 0;

  await tx`
    UPDATE order_items oi SET
      unit_price  = v.unit_price,
      gst_percent = ${gstPct}::numeric,
      gst_amount  = v.gst_amount,
      line_total  = v.line_total
    FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
         AS v(id uuid, unit_price numeric, gst_amount numeric, line_total numeric)
    WHERE oi.id = v.id
  `;

  // Order totals = sum of its lines (same footing as sumLines()).
  const changed = [...orderIds];
  await tx`
    UPDATE orders o SET
      subtotal    = s.subtotal,
      total_gst   = s.total_gst,
      grand_total = s.grand_total,
      updated_at  = now()
    FROM (
      SELECT order_id,
             SUM(line_total - gst_amount) AS subtotal,
             SUM(gst_amount)              AS total_gst,
             SUM(line_total)              AS grand_total
        FROM order_items
       WHERE order_id IN (
         SELECT jsonb_array_elements_text(${JSON.stringify(changed)}::jsonb)::uuid
       )
       GROUP BY order_id
    ) s
    WHERE o.id = s.order_id AND o.status = 'draft'
  `;
  return changed.length;
}
