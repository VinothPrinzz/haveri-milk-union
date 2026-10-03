import { pgClient } from "./lib/db.js";

async function main() {
  const rows = (await pgClient`
    WITH combined AS (
      SELECT oi.product_id, oi.gst_percent, oi.quantity, oi.line_total,
             o.delivery_date AS d, o.status::text AS st, 'order' AS rail
        FROM order_items oi JOIN orders o ON o.id = oi.order_id
       WHERE o.status IN ('confirmed','dispatched','delivered')
      UNION ALL
      SELECT dsi.product_id, dsi.gst_percent, dsi.quantity, dsi.line_total,
             ds.sale_date, ds.status::text, 'direct'
        FROM direct_sale_items dsi JOIN direct_sales ds ON ds.id = dsi.direct_sale_id
       WHERE ds.status = 'confirmed' AND ds.customer_type::text <> 'vip_sample'
      UNION ALL
      SELECT eoi.product_id, eoi.gst_percent, eoi.quantity, eoi.line_total,
             eo.delivery_date, eo.status::text, 'employee'
        FROM employee_order_items eoi JOIN employee_orders eo ON eo.id = eoi.employee_order_id
       WHERE eo.status IN ('confirmed','dispatched','delivered')
    )
    SELECT p.code, p.name, p.gst_percent::text AS master_pct,
           c.gst_percent::text AS line_pct, c.rail,
           COUNT(*)::int AS lines, SUM(c.quantity)::int AS units,
           MIN(c.d)::text AS first_date, MAX(c.d)::text AS last_date,
           SUM(c.line_total)::text AS gross
      FROM combined c JOIN products p ON p.id = c.product_id
     WHERE c.gst_percent <> p.gst_percent
       AND c.line_total > 0
     GROUP BY p.code, p.name, p.gst_percent, c.gst_percent, c.rail
     ORDER BY p.code, c.gst_percent
  `) as any[];
  console.log("Lines whose snapshot rate <> the product master rate (revenue lines only):");
  console.table(rows);
}
main().then(() => pgClient.end()).catch(async (e) => { console.error(e); await pgClient.end(); process.exit(1); });
