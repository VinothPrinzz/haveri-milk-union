// READ ONLY. Find the CHEESE PROCESSED BLOCK 1KG product rows (live or deleted).
import { pgClient } from "./lib/db.js";
const rows = (await pgClient`
  SELECT id, code, name, available, deleted_at, created_at, updated_at
  FROM products
  WHERE name ILIKE '%cheese%' OR code ILIKE '%cheese%'
  ORDER BY name, deleted_at NULLS FIRST
`) as any[];
console.table(rows);
await pgClient.end();
