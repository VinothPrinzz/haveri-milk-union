// Read-only: the GST Statement rows before and after the vip_sample exclusion.
import { pgClient } from "./lib/db.js";
const FROM = "2026-08-01", TO = "2026-08-21";

async function run(excludeVip: boolean) {
  return await pgClient`
    WITH combined AS (
      SELECT oi.product_id, oi.gst_percent, oi.quantity::int AS qty,
             oi.unit_price, oi.gst_amount, oi.line_total, false AS is_subsidy
      FROM orders o
      JOIN dealers d ON d.id = o.dealer_id
      JOIN order_items oi ON oi.order_id = o.id
      WHERE o.delivery_date >= ${FROM}::date AND o.delivery_date <= ${TO}::date
        AND o.created_at >= ${FROM}::date - interval '31 days'
        AND o.created_at <  ${TO}::date + interval '2 days'
        AND o.status IN ('confirmed','dispatched','delivered')
        AND COALESCE(d.customer_type::text, '') NOT LIKE 'Credit Inst%'
      UNION ALL
      SELECT dsi.product_id, dsi.gst_percent, dsi.quantity::int, dsi.unit_price,
             dsi.gst_amount, dsi.line_total,
             (ds.customer_type::text = 'employee_subsidy')
      FROM direct_sales ds
      JOIN direct_sale_items dsi ON dsi.direct_sale_id = ds.id
      WHERE ds.sale_date >= ${FROM}::date AND ds.sale_date <= ${TO}::date
        AND ds.status = 'confirmed'
        AND (NOT ${excludeVip}::boolean OR ds.customer_type::text <> 'vip_sample')
        AND ds.payment_mode::text <> 'credit'
      UNION ALL
      SELECT eoi.product_id, eoi.gst_percent, eoi.quantity::int, eoi.unit_price,
             eoi.gst_amount, eoi.line_total, true
      FROM employee_orders eo
      JOIN employee_order_items eoi ON eoi.employee_order_id = eo.id
      WHERE eo.delivery_date >= ${FROM}::date AND eo.delivery_date <= ${TO}::date
        AND eo.status IN ('confirmed','dispatched','delivered')
    )
    SELECT count(*)::int AS rows,
           SUM(qty)::int AS qty,
           SUM(taxable)::numeric AS taxable,
           SUM(tax)::numeric AS tax,
           SUM(invoice)::numeric AS invoice,
           count(*) FILTER (WHERE invoice = 0)::int AS zero_rows
      FROM (
        SELECT SUM(c.qty)::int AS qty,
               SUM(c.unit_price * c.qty)::numeric AS taxable,
               SUM(c.gst_amount)::numeric AS tax,
               SUM(c.line_total)::numeric AS invoice
          FROM combined c JOIN products p ON p.id = c.product_id
         GROUP BY p.id, c.gst_percent, c.is_subsidy
      ) g`;
}

async function main() {
  for (const excl of [false, true]) {
    const [r] = (await run(excl)) as any[];
    console.log(
      `${excl ? "AFTER  (vip excluded)" : "BEFORE (vip included) "}: ` +
      `rows=${String(r.rows).padStart(3)}  zero-value rows=${String(r.zero_rows).padStart(3)}  ` +
      `qty=${String(r.qty).padStart(6)}  taxable=${parseFloat(r.taxable).toFixed(2)}  ` +
      `tax=${parseFloat(r.tax).toFixed(2)}  invoice=${parseFloat(r.invoice).toFixed(2)}`);
  }
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
