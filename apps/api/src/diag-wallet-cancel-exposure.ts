// ═══════════════════════════════════════════════════════════════════════
// diag-wallet-cancel-exposure.ts — READ-ONLY. Writes nothing.
//
// Sizes the exposure from the wallet branch of adminCancelOrder, which
// credited grand_total back to the wallet on ANY payment_mode='wallet'
// order WITHOUT checking that the wallet was ever debited for it.
//
// Two questions, both answered here:
//
//   A. HISTORIC — which already-cancelled wallet orders were refunded more
//      than they ever took off the wallet? Each one handed the dealer money
//      the union never held. This is the damage already done.
//
//   B. EXPOSED  — which LIVE wallet orders would over-refund if cancelled
//      today? This is the damage still available, and it is what the fix
//      closes.
//
// Evidence, not flags: a wallet movement is only real if dealer_ledger says
// so. The placement debit, the modify up/down pair and the cancellation
// credit are all written in the SAME transaction as the dealer_wallets
// UPDATE (routes/orders.ts, lib/cancel-order.ts), so the ledger is a
// faithful record of what actually left the wallet.
//
//   net taken off the wallet =  Σ debit(order, adjustment)
//                             − Σ credit(refund, adjustment, order/Adjustment)
//
// voucher_type 'Receipt' is excluded: a cash / cheque / on-account receipt
// also lands on reference_type 'adjustment' and is money coming IN, not a
// wallet reversal. Same guard as balanceRefundedForOrder().
//
// USAGE (from apps/api):  npx tsx src/diag-wallet-cancel-exposure.ts
// ═══════════════════════════════════════════════════════════════════════

import { pgClient } from "./lib/db.js";

const money = (n: unknown) => Number(n ?? 0).toFixed(2);

async function main() {
  console.log("Wallet-cancel exposure — READ ONLY\n");

  // ── A. Already cancelled: refunded more than was ever debited ────────
  //
  // `refunded` here is what the cancel actually put back (the 'refund'
  // credit written by cancelOrderWithReversal's wallet branch), and
  // `debited` is the net that ever came off. refunded > debited is money
  // invented.
  const historic = await pgClient`
    SELECT o.id::text                                        AS order_id,
           d.name                                            AS dealer,
           d.phone                                           AS phone,
           o.grand_total::float8                             AS grand_total,
           o.cancelled_at,
           left(COALESCE(o.cancellation_reason, ''), 60)     AS reason,
           COALESCE((
             SELECT SUM(CASE WHEN dl.type = 'debit' THEN dl.amount ELSE -dl.amount END)
               FROM dealer_ledger dl
              WHERE dl.reference_id = o.id
                AND COALESCE(dl.voucher_type, '') <> 'Receipt'
                AND dl.reference_type::text IN ('order', 'adjustment')
                AND NOT (dl.type = 'credit' AND dl.reference_type::text = 'refund')
           ), 0)::float8                                     AS net_ledger,
           COALESCE((
             SELECT SUM(dl.amount)
               FROM dealer_ledger dl
              WHERE dl.reference_id = o.id
                AND dl.type = 'credit'
                AND dl.reference_type::text = 'refund'
           ), 0)::float8                                     AS refunded
      FROM orders o
      JOIN dealers d ON d.id = o.dealer_id
     WHERE o.payment_mode = 'wallet'
       AND o.status = 'cancelled'
     ORDER BY o.cancelled_at DESC
  `;

  const overRefunded = (historic as any[]).filter(
    (r) => Number(r.refunded) > Number(r.net_ledger) + 0.001
  );

  console.log(`A. HISTORIC — cancelled wallet orders: ${historic.length}`);
  if (overRefunded.length === 0) {
    console.log("   ✓ none refunded beyond what was debited\n");
  } else {
    const loss = overRefunded.reduce(
      (s, r) => s + (Number(r.refunded) - Number(r.net_ledger)), 0
    );
    console.log(`   ❌ ${overRefunded.length} over-refunded — Rs ${money(loss)} handed out\n`);
    console.table(
      overRefunded.map((r) => ({
        order: r.order_id.slice(0, 8),
        dealer: r.dealer,
        total: money(r.grand_total),
        debited: money(r.net_ledger),
        refunded: money(r.refunded),
        excess: money(Number(r.refunded) - Number(r.net_ledger)),
        cancelled: r.cancelled_at?.toISOString?.().slice(0, 10) ?? "",
      }))
    );
  }

  // ── B. Live orders that would over-refund if cancelled today ─────────
  const live = await pgClient`
    SELECT o.id::text                     AS order_id,
           d.name                         AS dealer,
           d.phone                        AS phone,
           o.status::text                 AS status,
           o.delivery_date,
           o.grand_total::float8          AS grand_total,
           COALESCE((
             SELECT SUM(CASE WHEN dl.type = 'debit' THEN dl.amount ELSE -dl.amount END)
               FROM dealer_ledger dl
              WHERE dl.reference_id = o.id
                AND COALESCE(dl.voucher_type, '') <> 'Receipt'
                AND dl.reference_type::text IN ('order', 'adjustment', 'refund')
           ), 0)::float8                  AS wallet_debited
      FROM orders o
      JOIN dealers d ON d.id = o.dealer_id
     WHERE o.payment_mode = 'wallet'
       AND o.status <> 'cancelled'
     ORDER BY o.delivery_date DESC
  `;

  const exposed = (live as any[]).filter(
    (r) => Number(r.grand_total) > Number(r.wallet_debited) + 0.001
  );

  console.log(`B. EXPOSED — live wallet orders: ${live.length}`);
  if (exposed.length === 0) {
    console.log("   ✓ every live wallet order is fully backed by a ledger debit\n");
  } else {
    const risk = exposed.reduce(
      (s, r) => s + (Number(r.grand_total) - Number(r.wallet_debited)), 0
    );
    console.log(
      `   ⚠️  ${exposed.length} would over-refund if cancelled — Rs ${money(risk)} at risk\n`
    );
    console.table(
      exposed.slice(0, 40).map((r) => ({
        order: r.order_id.slice(0, 8),
        dealer: r.dealer,
        status: r.status,
        delivery: r.delivery_date?.toISOString?.().slice(0, 10) ?? "",
        total: money(r.grand_total),
        debited: money(r.wallet_debited),
        excess: money(Number(r.grand_total) - Number(r.wallet_debited)),
      }))
    );
    if (exposed.length > 40) console.log(`   … and ${exposed.length - 40} more`);
  }

  // ── Summary ─────────────────────────────────────────────────────────
  console.log("\n── Summary ──");
  console.log(`cancelled wallet orders   : ${historic.length}`);
  console.log(`  over-refunded (damage)  : ${overRefunded.length}`);
  console.log(`live wallet orders        : ${live.length}`);
  console.log(`  would over-refund (risk): ${exposed.length}`);

  await pgClient.end();
  // Non-zero exit so this can gate CI or page from cron once the fix is in:
  // after the fix, B must stay empty.
  process.exit(exposed.length > 0 || overRefunded.length > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error("FAILED:", err);
  await pgClient.end().catch(() => {});
  process.exit(2);
});
