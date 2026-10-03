// Read-only: dump every price column so the paise migration can be reversed.
import { pgClient } from "./lib/db.js";
const rows = await pgClient`
  SELECT id, code, name, gst_percent, base_price, dealer_price, mrp,
         retail_dealer_price, credit_inst_mrp_price, credit_inst_dealer_price,
         parlour_dealer_price
    FROM products WHERE deleted_at IS NULL ORDER BY code`;
console.log(JSON.stringify(rows, null, 1));
process.exit(0);
