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

// ── Outbound-call timeout ───────────────────────────────────────────
// The Razorpay SDK sets no request timeout, so a slow or hung Razorpay call
// (or slow outbound network from the host) can block a /verify request far
// past the mobile client's own timeout — the dealer's app gives up while the
// server is still waiting, and the payment only records later via the webhook
// / reconcile backstop. Bounding every outbound call here lets the server
// return a definitive answer (or a clean 'pending') BEFORE the app aborts.
//
// Keep this comfortably BELOW the mobile client's request timeout. The verify
// path can make TWO sequential calls (payments.fetch → payments.capture), so
// 2 × this must still fit the app's budget (default 10s here vs a ~25s app
// timeout → 20s worst case, with headroom). Configurable via
// RAZORPAY_HTTP_TIMEOUT_MS.
export const RAZORPAY_TIMEOUT_MS = (() => {
  const n = parseInt(process.env.RAZORPAY_HTTP_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(n) && n >= 1000 ? n : 10_000;
})();

export class RazorpayTimeoutError extends Error {
  constructor(operation: string, ms: number) {
    super(`Razorpay ${operation} timed out after ${ms}ms`);
    this.name = "RazorpayTimeoutError";
  }
}

/**
 * Reject if `p` doesn't settle within `ms`. The underlying SDK request may
 * still finish in the background — its result is simply ignored — but the
 * caller is freed to respond promptly. Wraps every outbound Razorpay call.
 * On the /verify path a timeout surfaces as an INDETERMINATE result (the
 * money may have been captured), so the row is left recoverable rather than
 * marked failed — see ensureCaptured() in routes/dealer-payments.ts.
 */
function withTimeout<T>(
  operation: string,
  p: Promise<T>,
  ms: number = RAZORPAY_TIMEOUT_MS
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new RazorpayTimeoutError(operation, ms)),
      ms
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

export function getRazorpayKeyId(): string {
  if (!keyId) throw new Error("Razorpay not configured");
  return keyId;
}

export async function createRazorpayOrder(
  params: CreateOrderParams
): Promise<RazorpayOrder> {
  const client = await getClient();
  const amountPaise = Math.round(params.amountInRupees * 100);
  const order: any = await withTimeout(
    "orders.create",
    client.orders.create({
      amount: amountPaise,
      currency: "INR",
      receipt: params.receipt,
      notes: params.notes,
      // Auto-capture authorized payments. Belt-and-suspenders only: the
      // verify endpoints ALSO fetch the live payment status and capture
      // explicitly, so confirmation never depends on the account-level
      // capture setting (which is the real source of "authorized but not
      // captured" payments looking 'paid').
      payment_capture: 1,
    })
  );
  return {
    id: order.id,
    amount: typeof order.amount === "string" ? parseInt(order.amount, 10) : order.amount,
    currency: order.currency,
    receipt: order.receipt ?? null,
    status: order.status,
  };
}

export function isRazorpayConfigured(): boolean {
  return !!keyId && !!keySecret;
}

/**
 * Whether the webhook secret is present. The webhook is the real-time
 * safety net that applies captured payments the synchronous /verify call
 * misses; without RAZORPAY_WEBHOOK_SECRET every webhook fails signature
 * verification (see verifyWebhookSignature) and payments silently depend
 * on /verify alone. Surfaced at boot + in /api/v1/health so a missing
 * secret is visible immediately instead of after money goes unrecorded.
 */
export function isWebhookConfigured(): boolean {
  return !!webhookSecret;
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

export async function createRazorpayRefund(
  params: CreateRefundParams
): Promise<RazorpayRefund> {
  const client = await getClient();
  const amountPaise = Math.round(params.amountInRupees * 100);
  const refund: any = await withTimeout(
    "payments.refund",
    client.payments.refund(params.paymentId, {
      amount: amountPaise,
      speed: "normal",
      notes: params.notes,
    })
  );
  return {
    id: refund.id,
    status: refund.status,
    amount:
      typeof refund.amount === "string"
        ? parseInt(refund.amount, 10)
        : refund.amount,
  };
}

/**
 * Fetch the latest state of a refund from Razorpay. Used by the
 * finance Refunds screen to resync 'pending' rows. Read-only.
 */
export async function fetchRazorpayRefund(
  refundId: string
): Promise<{ id: string; status: string; error_description: string | null }> {
  const client = await getClient();
  const refund: any = await withTimeout("refunds.fetch", client.refunds.fetch(refundId));
  return {
    id: refund.id,
    status: refund.status,
    error_description:
      (refund as { error_description?: string | null }).error_description ?? null,
  };
}

/**
 * Fetch the live state of a payment from Razorpay. This is the
 * authoritative source of truth for whether money was actually taken —
 * the checkout signature only proves the (order_id, payment_id) pair is
 * authentic, NOT that the payment reached 'captured'. Read-only.
 */
export async function fetchRazorpayPayment(paymentId: string): Promise<{
  id: string;
  order_id: string | null;
  status: string;            // created | authorized | captured | refunded | failed
  amount: number;            // paise
  currency: string;
  error_code: string | null;
  error_description: string | null;
}> {
  const client = await getClient();
  const p: any = await withTimeout("payments.fetch", client.payments.fetch(paymentId));
  return {
    id: p.id,
    order_id: (p as { order_id?: string | null }).order_id ?? null,
    status: p.status,
    amount: typeof p.amount === "string" ? parseInt(p.amount, 10) : p.amount,
    currency: p.currency,
    error_code: (p as { error_code?: string | null }).error_code ?? null,
    error_description:
      (p as { error_description?: string | null }).error_description ?? null,
  };
}

/**
 * List every payment attempt made against a Razorpay order. Used by the
 * reconciliation job to discover the captured payment id for a stuck row
 * that never received a webhook or a synchronous /verify (the row only
 * stores the razorpay_order_id, not the winning payment id). Read-only.
 */
export async function fetchRazorpayOrderPayments(orderId: string): Promise<
  Array<{
    id: string;
    status: string; // created | authorized | captured | refunded | failed
    amount: number; // paise
    currency: string;
    error_code: string | null;
    error_description: string | null;
  }>
> {
  const client = await getClient();
  const res = await withTimeout(
    "orders.fetchPayments",
    client.orders.fetchPayments(orderId)
  );
  const items = ((res as { items?: unknown[] })?.items ?? []) as Array<
    Record<string, unknown>
  >;
  return items.map((p) => ({
    id: p.id as string,
    status: p.status as string,
    amount: typeof p.amount === "string" ? parseInt(p.amount, 10) : (p.amount as number),
    currency: p.currency as string,
    error_code: (p.error_code as string | null) ?? null,
    error_description: (p.error_description as string | null) ?? null,
  }));
}

/**
 * Capture an authorized payment. Required when the account default is
 * manual capture: without this the money stays only authorized and is
 * auto-voided by Razorpay after a few days. `amountPaise` must equal the
 * authorized amount.
 */
export async function captureRazorpayPayment(
  paymentId: string,
  amountPaise: number,
  currency = "INR"
): Promise<{ status: string }> {
  const client = await getClient();
  const p: any = await withTimeout(
    "payments.capture",
    client.payments.capture(paymentId, amountPaise, currency)
  );
  return { status: p.status };
}

export interface CreateRefundParams {
  paymentId: string;            // pay_xxxxxx
  amountInRupees: number;       // partial or full
  notes: Record<string, string>;
}
 
export interface RazorpayRefund {
  id: string;                   // rfnd_xxxxxx
  status: string;               // 'pending' | 'processed' | 'failed'
  amount: number;               // paise
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