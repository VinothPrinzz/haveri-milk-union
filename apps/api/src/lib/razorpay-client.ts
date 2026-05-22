// ═══════════════════════════════════════════════════════════════════════
// apps/api/src/lib/razorpay-client.ts  —  TRULY BUILD-SAFE VERSION
//
// PREVIOUS FIX WAS INCOMPLETE:
//   `const RAZORPAY_MODULE = "razorpay"` keeps the LITERAL type
//   "razorpay", and TypeScript STILL resolves `import(literalType)`
//   at build time → "Cannot find module 'razorpay'" → build fails.
//
//   The fix: annotate the specifier as plain `string`. TypeScript
//   does NOT do module resolution on `import(x)` when `x` is typed
//   as a general `string`. Plus a @ts-ignore for belt-and-suspenders.
//
// TO ENABLE PAYMENTS: pnpm --filter api add razorpay  (+ env vars)
// ═══════════════════════════════════════════════════════════════════════

import crypto from "node:crypto";

const keyId = process.env.RAZORPAY_KEY_ID;
const keySecret = process.env.RAZORPAY_KEY_SECRET;
const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

if (!keyId || !keySecret) {
  console.warn(
    "[razorpay-client] RAZORPAY_KEY_ID/SECRET not set — payment endpoints return 503"
  );
}

// ── Lazy SDK loader ─────────────────────────────────────────────────
// `: string` annotation widens the type away from the literal
// "razorpay", so TS will not attempt to resolve the module.
const RAZORPAY_PKG: string = "razorpay";
let RazorpayCtor: any = null;

async function getRazorpayCtor(): Promise<any> {
  if (RazorpayCtor) return RazorpayCtor;
  try {
    // @ts-ignore - optional dependency; may be absent at build time
    const mod: any = await import(RAZORPAY_PKG);
    RazorpayCtor = mod?.default ?? mod;
    return RazorpayCtor;
  } catch {
    throw new Error(
      "Razorpay SDK not installed. Run: pnpm --filter api add razorpay"
    );
  }
}

let _client: any = null;
async function getClient(): Promise<any> {
  if (_client) return _client;
  if (!keyId || !keySecret) {
    throw new Error(
      "Razorpay credentials not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET."
    );
  }
  const Ctor = await getRazorpayCtor();
  _client = new Ctor({ key_id: keyId, key_secret: keySecret });
  return _client;
}

export function getRazorpayKeyId(): string {
  if (!keyId) throw new Error("Razorpay not configured");
  return keyId;
}

export function isRazorpayConfigured(): boolean {
  return !!keyId && !!keySecret;
}

export interface CreateOrderParams {
  amountInRupees: number;
  receipt: string;
  notes: Record<string, string>;
}

export interface RazorpayOrder {
  id: string;
  amount: number;
  currency: string;
  receipt: string | null;
  status: string;
}

export async function createRazorpayOrder(
  params: CreateOrderParams
): Promise<RazorpayOrder> {
  const client = await getClient();
  const amountPaise = Math.round(params.amountInRupees * 100);
  const order = await client.orders.create({
    amount: amountPaise,
    currency: "INR",
    receipt: params.receipt,
    notes: params.notes,
    payment_capture: true,
  });
  return {
    id: order.id,
    amount:
      typeof order.amount === "string"
        ? parseInt(order.amount, 10)
        : order.amount,
    currency: order.currency,
    receipt: order.receipt ?? null,
    status: order.status,
  };
}

// ── Signature verification (crypto-only) ────────────────────────────

export function verifyPaymentSignature(params: {
  razorpayOrderId: string;
  razorpayPaymentId: string;
  razorpaySignature: string;
}): boolean {
  if (!keySecret) return false;
  const payload = `${params.razorpayOrderId}|${params.razorpayPaymentId}`;
  const expected = crypto
    .createHmac("sha256", keySecret)
    .update(payload)
    .digest("hex");
  return timingSafeEqual(expected, params.razorpaySignature);
}

export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string
): boolean {
  if (!webhookSecret) return false;
  const expected = crypto
    .createHmac("sha256", webhookSecret)
    .update(rawBody)
    .digest("hex");
  return timingSafeEqual(expected, signatureHeader);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}