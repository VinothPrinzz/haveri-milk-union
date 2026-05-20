// ═══════════════════════════════════════════════════════════════════════
// apps/api/src/lib/razorpay-client.ts
//
// Thin wrapper around the Razorpay Node SDK. All Razorpay-side
// interactions go through this file so credentials and HMAC logic
// live in one place.
//
// Env vars required:
//   RAZORPAY_KEY_ID         (public — also sent to the mobile client)
//   RAZORPAY_KEY_SECRET     (server-only)
//   RAZORPAY_WEBHOOK_SECRET (server-only — set in Razorpay Dashboard
//                            under Settings → Webhooks)
//
// Install:
//   pnpm --filter @hmu/api add razorpay
// ═══════════════════════════════════════════════════════════════════════

import crypto from "node:crypto";
import Razorpay from "razorpay";

// ── Config ──────────────────────────────────────────────────────────
const keyId = process.env.RAZORPAY_KEY_ID;
const keySecret = process.env.RAZORPAY_KEY_SECRET;
const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

if (!keyId || !keySecret) {
  // We DON'T throw at module load — the API can still start without
  // Razorpay configured (other endpoints work). But any call to
  // createOrder will fail clearly. This makes local dev easier.
  console.warn(
    "[razorpay-client] RAZORPAY_KEY_ID/SECRET not set — Razorpay endpoints will return 503"
  );
}

let _client: Razorpay | null = null;
function getClient(): Razorpay {
  if (!_client) {
    if (!keyId || !keySecret) {
      throw new Error(
        "Razorpay credentials not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET."
      );
    }
    _client = new Razorpay({ key_id: keyId, key_secret: keySecret });
  }
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
  /** Amount in rupees (we convert to paise here) */
  amountInRupees: number;
  /** Short identifier shown in dashboard — `topup-<dealerCode>` or `order-<orderId>` */
  receipt: string;
  /** Razorpay's `notes` field — arbitrary key/value for our reference */
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
  const client = getClient();
  // Razorpay wants amount in paise (integer). We round to avoid float issues.
  const amountPaise = Math.round(params.amountInRupees * 100);
  const order = await client.orders.create({
    amount: amountPaise,
    currency: "INR",
    receipt: params.receipt,
    notes: params.notes,
    payment_capture: true, // auto-capture on success
  } as any);
  return {
    id: order.id,
    amount: typeof order.amount === "string" ? parseInt(order.amount, 10) : order.amount,
    currency: order.currency,
    receipt: order.receipt ?? null,
    status: order.status,
  };
}

// ── Signature verification ──────────────────────────────────────────
//
// The client-side flow on a successful payment returns three values:
//   razorpay_order_id   (matches the order we created)
//   razorpay_payment_id (the actual payment, pay_xxxxx)
//   razorpay_signature  (HMAC for us to verify)
//
// Verification recipe (from Razorpay docs):
//   expected = HMAC_SHA256(
//     `${razorpay_order_id}|${razorpay_payment_id}`,
//     KEY_SECRET
//   )
//   if expected === razorpay_signature → trust the payment

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

// ── Webhook signature ───────────────────────────────────────────────
//
// Razorpay signs the RAW request body with the webhook secret and
// sends the result in the X-Razorpay-Signature header. We must
// compute against the raw bytes, not the JSON-parsed object.
//
// Fastify's default JSON parser consumes the body. For the webhook
// route, register a custom content-type parser that stashes the raw
// buffer alongside the parsed JSON — see dealer-payments.ts.

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

// ── HMAC compare (timing-safe) ──────────────────────────────────────
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}