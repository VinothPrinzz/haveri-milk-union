// ═══════════════════════════════════════════════════════════════════════
// cleanup-superseded-drafts.ts — one-time repair for stranded twins.
//
// Problem (July 2026): dealers ended up with a PLACED order (confirmed /
// dispatched / delivered) AND one or more stranded draft/payment_required
// twins for the same delivery date — duplicates the partitioned orders
// table couldn't block. The twins show "awaiting payment" for goods that
// were already paid & delivered, and their "Pay for this indent" button
// would charge the dealer twice.
//
// The supersede rule (apps/api/src/lib/supersede-orders.ts) now cancels
// twins at confirm time; this script sweeps the ones created BEFORE that
// fix.
//
// A twin is cancelled only when ALL hold (same guards as the live rule):
//   • a placed sibling exists (same dealer, same delivery_date)
//   • the twin is 'draft' or 'payment_required'
//   • it has NO razorpay_payments row with status='paid'
//   • it has NO dealer_ledger 'order' debit
// Stock latched by a twin (cart-UPI orders deduct at creation) is
// restored via the stock_deducted latch.
//
// USAGE (from packages/db):
//   npx tsx src/cleanup-superseded-drafts.ts           ← dry run (default)
//   npx tsx src/cleanup-superseded-drafts.ts --apply   ← actually cancel
// ═══════════════════════════════════════════════════════════════════════

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import postgres from "postgres";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

const APPLY = process.argv.includes("--apply");
const sql = postgres(process.env.DATABASE_URL!, { max: 1 });

const SUPERSEDE_REASON_PREFIX = "Superseded by placed order ";

interface Twin {
  loser_id: string;
  loser_status: string;
  loser_total: string;
  loser_stock_deducted: boolean;
  winner_id: string;
  winner_status: string;
  winner_total: string;
  dealer_name: string;
  delivery_date: string;
  loser_created: Date;
}

async function main() {
  // For each stranded twin pick ONE winner: the most-progressed, newest
  // placed sibling (same ranking the 0034 pre-flight suggested).
  const twins: Twin[] = await sql`
    SELECT DISTINCT ON (l.id)
           l.id::text                AS loser_id,
           l.status::text            AS loser_status,
           l.grand_total::text       AS loser_total,
           l.stock_deducted          AS loser_stock_deducted,
           l.created_at              AS loser_created,
           w.id::text                AS winner_id,
           w.status::text            AS winner_status,
           w.grand_total::text       AS winner_total,
           d.name                    AS dealer_name,
           l.delivery_date::text     AS delivery_date
      FROM orders l
      JOIN orders w
        ON w.dealer_id = l.dealer_id
       AND w.delivery_date = l.delivery_date
       AND w.id <> l.id
       AND w.status IN ('confirmed', 'dispatched', 'delivered')
      JOIN dealers d ON d.id = l.dealer_id
     WHERE l.status IN ('draft', 'payment_required')
       AND NOT EXISTS (SELECT 1 FROM razorpay_payments rp
                        WHERE rp.order_id = l.id AND rp.status = 'paid')
       AND NOT EXISTS (SELECT 1 FROM dealer_ledger dl
                        WHERE dl.reference_id = l.id
                          AND dl.reference_type = 'order'
                          AND dl.type = 'debit')
     ORDER BY l.id,
              CASE w.status WHEN 'delivered' THEN 3
                            WHEN 'dispatched' THEN 2
                            ELSE 1 END DESC,
              w.created_at DESC
  `;

  if (twins.length === 0) {
    console.log("Nothing to clean up — no stranded twins found. ✅");
    await sql.end();
    return;
  }

  console.log(
    `${APPLY ? "APPLYING" : "DRY RUN"} — ${twins.length} stranded twin(s) found:\n`
  );
  for (const t of twins) {
    console.log(
      `  ${t.delivery_date}  ${t.dealer_name}\n` +
        `    cancel → ${t.loser_id}  (${t.loser_status}, ₹${t.loser_total}` +
        `${t.loser_stock_deducted ? ", stock latched — will restore" : ""})\n` +
        `    kept   → ${t.winner_id}  (${t.winner_status}, ₹${t.winner_total})`
    );
  }

  if (!APPLY) {
    console.log(
      `\nDry run only. Re-run with --apply to cancel these ${twins.length} order(s).`
    );
    await sql.end();
    return;
  }

  let cancelled = 0;
  let stockRestored = 0;
  for (const t of twins) {
    await sql.begin(async (tx) => {
      // Status re-guarded: a concurrent confirm/cancel since the SELECT
      // makes this a no-op instead of clobbering.
      const upd = await tx`
        UPDATE orders
           SET status = 'cancelled',
               cancellation_reason = ${SUPERSEDE_REASON_PREFIX + t.winner_id + " (cleanup)"},
               cancelled_at = now(),
               updated_at = now()
         WHERE id = ${t.loser_id}::uuid
           AND status IN ('draft', 'payment_required')
           AND NOT EXISTS (SELECT 1 FROM razorpay_payments rp
                            WHERE rp.order_id = orders.id AND rp.status = 'paid')
           AND NOT EXISTS (SELECT 1 FROM dealer_ledger dl
                            WHERE dl.reference_id = orders.id
                              AND dl.reference_type = 'order'
                              AND dl.type = 'debit')
        RETURNING id
      `;
      if (upd.count === 0) {
        console.log(`  ⏭️  ${t.loser_id} moved on since the scan — skipped`);
        return;
      }
      cancelled++;

      // Latch-guarded stock restore (mirror of restoreOrderStock).
      const released = await tx`
        UPDATE orders SET stock_deducted = false, updated_at = now()
         WHERE id = ${t.loser_id}::uuid AND stock_deducted = true
        RETURNING id
      `;
      if (released.count > 0) {
        stockRestored++;
        const items = await tx`
          SELECT product_id::text AS product_id, quantity AS quantity
            FROM order_items WHERE order_id = ${t.loser_id}::uuid
        `;
        for (const it of items as any[]) {
          await tx`
            UPDATE products
               SET stock = stock + ${it.quantity}, updated_at = now()
             WHERE id = ${it.product_id}::uuid
          `;
        }
      }
    });
  }

  console.log(
    `\nDone: ${cancelled} cancelled, ${stockRestored} had stock restored. ✅`
  );
  await sql.end();
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
