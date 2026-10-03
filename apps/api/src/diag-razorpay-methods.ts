// ═══════════════════════════════════════════════════════════════════════
// diag-razorpay-methods.ts — READ ONLY (GET /v1/payments only).
//
// We store every Razorpay settlement as payments.mode='upi' and
// orders.payment_mode='upi'; the instrument the dealer actually used is
// never captured (the webhook drops payment.entity.method, and
// razorpay_payments has no column for it). This asks Razorpay what those
// payments really were, and cross-references them against what we stored.
//
// USAGE (from apps/api):  npx tsx src/diag-razorpay-methods.ts [days]
// ═══════════════════════════════════════════════════════════════════════

import { pgClient } from "./lib/db.js";

const days = Number(process.argv[2] ?? 90);
const keyId = process.env.RAZORPAY_KEY_ID;
const keySecret = process.env.RAZORPAY_KEY_SECRET;
if (!keyId || !keySecret) throw new Error("RAZORPAY_KEY_ID/SECRET not set");
const auth = "Basic " + Buffer.from(`${keyId}:${keySecret}`).toString("base64");

const inr = (paise: number) =>
  "₹" + (paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

interface RzpPayment {
  id: string;
  status: string;
  method: string;
  amount: number;
  card?: { network?: string; type?: string } | null;
  wallet?: string | null;
  bank?: string | null;
  vpa?: string | null;
  created_at: number;
}

/** Page through GET /v1/payments for the window. Read-only. */
async function listPayments(fromUnix: number, toUnix: number): Promise<RzpPayment[]> {
  const out: RzpPayment[] = [];
  const COUNT = 100;
  for (let skip = 0; skip < 20000; skip += COUNT) {
    const url = `https://api.razorpay.com/v1/payments?count=${COUNT}&skip=${skip}&from=${fromUnix}&to=${toUnix}`;
    const res = await fetch(url, { headers: { Authorization: auth } });
    if (!res.ok) throw new Error(`Razorpay ${res.status}: ${await res.text()}`);
    const body: any = await res.json();
    const items: RzpPayment[] = body.items ?? [];
    out.push(...items);
    process.stdout.write(`\r  fetched ${out.length} payments…`);
    if (items.length < COUNT) break;
  }
  process.stdout.write("\n");
  return out;
}

async function main() {
  const toUnix = Math.floor(Date.now() / 1000);
  const fromUnix = toUnix - days * 86400;
  console.log(`Razorpay payments, last ${days} days (live account)\n`);

  const all = await listPayments(fromUnix, toUnix);
  const captured = all.filter(p => p.status === "captured" || p.status === "refunded");

  // ── 1. What instruments were actually used ──
  const byMethod = new Map<string, { n: number; paise: number }>();
  for (const p of captured) {
    const key = p.method + (p.method === "card" && p.card?.type ? ` (${p.card.type})` : "");
    const c = byMethod.get(key) ?? { n: 0, paise: 0 };
    c.n++; c.paise += p.amount;
    byMethod.set(key, c);
  }
  console.log("── Captured payments by real instrument ──");
  console.table(
    [...byMethod.entries()]
      .sort((a, b) => b[1].n - a[1].n)
      .map(([method, v]) => ({ method, count: v.n, amount: inr(v.paise) }))
  );

  // ── 2. What we stored for those same payments ──
  const ids = captured.map(p => p.id);
  const rows = ids.length
    ? await pgClient`
        SELECT rp.razorpay_payment_id AS pay_id,
               rp.kind::text          AS kind,
               p.mode                 AS stored_mode,
               o.payment_mode::text   AS order_mode
        FROM razorpay_payments rp
        LEFT JOIN payments p ON p.reference = rp.razorpay_payment_id
        LEFT JOIN orders o   ON o.id = rp.order_id
        WHERE rp.razorpay_payment_id = ANY(${ids})
      `
    : [];
  const stored = new Map((rows as any[]).map(r => [r.pay_id, r]));

  const cross = new Map<string, { n: number; paise: number }>();
  for (const p of captured) {
    const s = stored.get(p.id);
    const key = `${p.method} → payments.mode='${s?.stored_mode ?? "(no row)"}'`
      + `, orders.payment_mode='${s?.order_mode ?? "-"}' [${s?.kind ?? "not in our DB"}]`;
    const c = cross.get(key) ?? { n: 0, paise: 0 };
    c.n++; c.paise += p.amount;
    cross.set(key, c);
  }
  console.log("── Real instrument → what we stored ──");
  console.table(
    [...cross.entries()]
      .sort((a, b) => b[1].n - a[1].n)
      .map(([k, v]) => ({ mapping: k, count: v.n, amount: inr(v.paise) }))
  );

  // ── 3. Every non-UPI payment, itemised ──
  const nonUpi = captured.filter(p => p.method !== "upi");
  if (nonUpi.length) {
    console.log(`── The ${nonUpi.length} non-UPI payments in full ──`);
    console.table(
      nonUpi
        .sort((a, b) => a.created_at - b.created_at)
        .map(p => {
          const s = stored.get(p.id);
          return {
            date: new Date(p.created_at * 1000).toISOString().slice(0, 10),
            payment_id: p.id,
            method: p.method,
            detail: p.card ? `${p.card.network ?? ""} ${p.card.type ?? ""}`.trim() : (p.wallet ?? p.bank ?? ""),
            amount: inr(p.amount),
            kind: s?.kind ?? "not in our DB",
            stored_as: s?.stored_mode ?? "(no payments row)",
          };
        })
    );
  } else {
    console.log("── No non-UPI captured payments in this window ──");
  }

  await pgClient.end();
}

main().catch(e => { console.error(e); process.exit(1); });
