// ═══════════════════════════════════════════════════════════════════════
// apps/api/src/lib/razorpay-client.ts  —  BUILD-SAFE VERSION
//
// CHANGE FROM PREVIOUS VERSION:
//   The old file did `import Razorpay from "razorpay"` at the top.
//   When the `razorpay` package isn't installed, that's a hard
//   TypeScript error (TS2307 "Cannot find module") — which fails the
//   ENTIRE `tsc` build, so NONE of the API routes get deployed
//   (including dealer-indents.ts, which has nothing to do with
//   Razorpay). That's what caused /api/v1/dealer/drafts/* to 404.
//
//   This version loads the SDK via a DYNAMIC import through a
//   variable specifier. TypeScript does not resolve variable-based
//   import() calls, so the build succeeds whether or not `razorpay`
//   is installed. Payment endpoints simply return 503 until the
//   package is added and credentials are configured.
//
// TO ACTUALLY ENABLE PAYMENTS (Phase 2B):
//   pnpm --filter api add razorpay
//   then set RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET / RAZORPAY_WEBHOOK_SECRET
//
// The HMAC functions (verifyPaymentSignature, verifyWebhookSignature)
// use only Node's built-in crypto — they need no package at all.
// ═══════════════════════════════════════════════════════════════════════

import crypto from "node:crypto";

// ── Config ──────────────────────────────────────────────────────────
const keyId = process.env.RAZORPAY_KEY_ID;
const keySecret = process.env.RAZORPAY_KEY_SECRET;
const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

if (!keyId || !keySecret) {
  console.warn(
    "[razorpay-client] RAZORPAY_KEY_ID/SECRET not set — payment endpoints return 503"
  );
}

// ── Lazy SDK loader ─────────────────────────────────────────────────
// The specifier is a variable, NOT a string literal. TypeScript only
// does module resolution on literal specifiers, so this compiles even
// when `razorpay` is absent from node_modules.
const RAZORPAY_MODULE = "razorpay";
let RazorpayCtor: any = null;

async function getRazorpayCtor(): Promise<any> {
  if (RazorpayCtor) return RazorpayCtor;
  try {
    const mod: any = await import(RAZORPAY_MODULE);
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

/** Public key id — safe to send to the mobile client. */
export function getRazorpayKeyId(): string {
  if (!keyId) throw new Error("Razorpay not configured");
  return keyId;
}

export function isRazorpayConfigured(): boolean {
  return !!keyId && !!keySecret;
}

// ── Orders ──────────────────────────────────────────────────────────

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

// ── Signature verification (crypto-only, no SDK needed) ─────────────

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