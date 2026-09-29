// Read-only: before narrowing the AMOUNT columns back to 2dp, prove no row
// anywhere already carries a non-zero third decimal. If this reports 0
// everywhere, the narrowing rounds nothing and is fully lossless.
import { pgClient } from "./lib/db.js";

// table -> amount columns that are about to go back to numeric(_,2)
const AMOUNTS: Record<string, string[]> = {
  orders: ["subtotal", "total_gst", "grand_total"],
  order_items: ["gst_amount", "line_total"],
  direct_sales: ["subtotal", "total_gst", "grand_total"],
  direct_sale_items: ["gst_amount", "line_total"],
  employee_orders: ["subtotal", "total_gst", "grand_total"],
  employee_order_items: ["gst_amount", "line_total"],
  employees: ["credit_limit", "opening_balance"],
  employee_ledger: ["amount", "balance_after"],
  dealers: ["credit_limit", "opening_balance", "current_balance"],
  dealer_wallets: ["balance", "last_topup_amount"],
  dealer_ledger: ["amount", "balance_after"],
  invoices: ["taxable_amount", "cgst", "sgst", "total_tax", "total_amount", "paid_amount"],
  payments: ["amount"],
  cheques: ["amount", "bank_charges"],
  razorpay_payments: ["amount", "amount_refunded"],
  razorpay_refunds: ["amount"],
  settlements: ["total_amount", "gateway_fee", "tax_on_fee", "axis_credited_amount"],
  bank_reconciliation: ["bank_statement_amount", "system_amount", "difference"],
  route_sheets: ["total_amount"],
  stock_receipts: ["total_cost"],
};

async function main() {
  let offenders = 0;
  let checked = 0;
  for (const [table, cols] of Object.entries(AMOUNTS)) {
    for (const col of cols) {
      checked++;
      const [r] = await pgClient.unsafe(
        `SELECT COUNT(*)::int AS n
           FROM ${table}
          WHERE ${col} IS NOT NULL
            AND (${col} * 1000)::bigint % 10 <> 0`
      );
      const n = (r as any).n as number;
      if (n > 0) {
        offenders += n;
        console.log(`   ⚠ ${table}.${col}: ${n} rows with a non-zero 3rd decimal`);
      }
    }
  }
  console.log(`amount columns checked: ${checked}`);
  console.log(`rows that would be rounded by narrowing: ${offenders}`);
  console.log(offenders === 0 ? "\nLOSSLESS — safe to narrow" : "\nNOT lossless — narrowing would round real data");
  await pgClient.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
