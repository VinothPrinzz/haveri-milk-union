// apps/api/src/lib/order-modifications.ts
// ════════════════════════════════════════════════════════════════════
// Log of modifies to placed indents and agent gate passes (0085), shown
// on the dealer statement. Call inside the modify's transaction so the
// log and the change commit (or roll back) together.
// ════════════════════════════════════════════════════════════════════
import { pgClient } from "./db.js";

type Sql = typeof pgClient;
export interface ModLine { productId: string; qty: number }

/** "24 Toned 500ml, 12 Curd 500g" style names for the logged lines. */
async function named(tx: Sql, lines: ModLine[]) {
  const live = lines.filter(l => Number(l.qty) > 0);
  if (!live.length) return [];
  const rows = await tx`
    SELECT id::text AS id, COALESCE(NULLIF(trim(report_alias), ''), name) AS name
      FROM products
     WHERE id = ANY(string_to_array(${live.map(l => l.productId).join(",")}, ',')::uuid[])
  ` as any[];
  const nameOf = new Map(rows.map(r => [r.id as string, r.name as string]));
  return live.map(l => ({ productId: l.productId, name: nameOf.get(l.productId) ?? "Product", qty: Number(l.qty) }));
}

export async function recordOrderModification(tx: Sql, m: {
  source: "order" | "gate_pass";
  orderId: string;
  dealerId: string;
  oldTotal: number;
  newTotal: number;
  oldItems: ModLine[];
  newItems: ModLine[];
  userId: string | null;
}) {
  const delta = Math.round((m.newTotal - m.oldTotal) * 100) / 100;
  const oldItems = await named(tx, m.oldItems);
  const newItems = await named(tx, m.newItems);
  await tx`
    INSERT INTO order_modifications
      (source, order_id, dealer_id, modified_by, old_total, new_total, delta, old_items, new_items)
    VALUES
      (${m.source}, ${m.orderId}::uuid, ${m.dealerId}::uuid, ${m.userId}::uuid,
       ${m.oldTotal.toFixed(2)}::numeric, ${m.newTotal.toFixed(2)}::numeric, ${delta.toFixed(2)}::numeric,
       ${JSON.stringify(oldItems)}::jsonb, ${JSON.stringify(newItems)}::jsonb)
  `;
}
