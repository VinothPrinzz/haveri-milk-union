// WRITES. Undo the 2026-10-14 soft delete of PD0241 CHEESE PROCESSED BLOCK 1KG.
import { pgClient } from "./lib/db.js";
const rows = (await pgClient`
  UPDATE products SET deleted_at = NULL, updated_at = now()
  WHERE id = 'cae9672f-f9f0-4eaf-bdf8-0cac34140a41' AND code = 'PD0241' AND deleted_at IS NOT NULL
  RETURNING code, name, available, deleted_at, base_price, dealer_price
`) as any[];
console.table(rows);
await pgClient.end();
