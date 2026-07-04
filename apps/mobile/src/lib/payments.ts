// ═══════════════════════════════════════════════════════════════════════
// src/lib/payments.ts — shared Razorpay /verify caller.
//
// The verify endpoints have THREE outcomes, not two, and conflating them is
// exactly what once showed a dealer "payment failed" while ₹925 had been
// captured (order_T8srd7uSwdMtmp):
//
//   • 200 { ok: true }            → confirmed, returned to the caller
//   • 202 { status: "pending" }   → server couldn't reach Razorpay to
//     confirm; money may be captured → throw PaymentPending
//   • timeout / network / 5xx     → same uncertainty on our side of the
//     wire → throw PaymentPending
//   • 400 / 402                   → definitive failure → rethrown as-is
//
// NOTE a 202 does NOT throw in apiFetch (it's a 2xx), so the pending body
// is detected by the absence of `ok: true` — not by a caught error.
// ═══════════════════════════════════════════════════════════════════════

import { api, ApiError } from "./api";
import { PaymentPending } from "./razorpay";

// The backend bounds each of its outbound Razorpay calls at ~10s and the
// verify path can chain two (payments.fetch → capture), so give /verify a
// 25s budget — enough to receive the server's definitive answer (or its
// clean 202 "pending") instead of aborting first. One network retry:
// verify is idempotent server-side, and on rural links a fresh connection
// often succeeds where a congested one dropped.
const VERIFY_TIMEOUT_MS = 25_000;

export async function verifyPayment<
  T extends { ok?: boolean; message?: string; orderId?: string | null }
>(path: string, body: unknown): Promise<T & { ok: true }> {
  let res: T;
  try {
    res = await api<T>(path, {
      method: "POST",
      body,
      timeoutMs: VERIFY_TIMEOUT_MS,
      networkRetries: 1,
    });
  } catch (err) {
    if (err instanceof ApiError && (err.status === 0 || err.status >= 500)) {
      // Couldn't get an answer — the capture may still have landed.
      throw new PaymentPending();
    }
    throw err; // 400 / 402 → definitive, surface to the caller
  }
  if (res?.ok !== true) {
    // 202 pending body (or an unexpected 2xx shape — treat the same:
    // never claim success without an explicit ok).
    throw new PaymentPending(res?.message ?? undefined, res?.orderId ?? null);
  }
  return res as T & { ok: true };
}
