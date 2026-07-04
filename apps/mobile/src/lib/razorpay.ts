// ═══════════════════════════════════════════════════════════════════════
// apps/mobile/src/lib/razorpay.ts
//
// Thin wrapper around react-native-razorpay so the rest of the app
// doesn't have to know SDK details.
//
// Install:
//   cd apps/mobile && pnpm add react-native-razorpay
//   (Expo: also requires a config plugin or a dev-client build —
//    see README_PHASE_2B.md for the exact steps.)
//
// Usage:
//   const result = await openRazorpayCheckout({
//     keyId: rsp.keyId,
//     amountPaise: rsp.amountPaise,
//     orderId: rsp.razorpayOrderId,
//     description: "Top up credit limit",
//     prefill: { contact: dealer.phone, name: dealer.name },
//   });
//   // result.razorpayPaymentId etc., or throws RazorpayCancelled
// ═══════════════════════════════════════════════════════════════════════

import RazorpayCheckout from "react-native-razorpay";
import { useAuthStore } from "../store/auth";

export interface RazorpayOpenParams {
  keyId: string;
  /** Amount in paise (integer). Backend returns this directly. */
  amountPaise: number;
  /** Razorpay order id from /credit-topup/order or /pay-now */
  orderId: string;
  /** Short description shown in the Razorpay sheet */
  description: string;
  /** Auto-fill for the prefill fields */
  prefill?: {
    name?: string;
    email?: string;
    contact?: string;
  };
  /** Customization */
  theme?: { color?: string };
}

export interface RazorpaySuccess {
  razorpayPaymentId: string;
  razorpayOrderId: string;
  razorpaySignature: string;
}

/** Thrown when the user closes the sheet without paying. */
export class RazorpayCancelled extends Error {
  constructor(public reason?: string) {
    super(reason ?? "Payment cancelled");
    this.name = "RazorpayCancelled";
  }
}

/** Thrown when Razorpay returns an error (declined card, network, etc.) */
export class RazorpayFailed extends Error {
  constructor(public code: string | undefined, public description: string) {
    super(description);
    this.name = "RazorpayFailed";
  }
}

/**
 * Thrown when the payment likely SUCCEEDED on Razorpay's side but the server
 * couldn't give a definitive answer in time — the /verify call returned
 * 202 "pending", timed out, or hit a network/server error. The money may
 * already be captured; the backend's webhook / reconciliation job will
 * confirm the order automatically within minutes. Callers must show
 * "confirming…" — NEVER "failed" (the dealer might pay twice) and NEVER
 * "confirmed" (it isn't yet).
 */
export class PaymentPending extends Error {
  constructor(message?: string, public orderId?: string | null) {
    super(
      message ??
        "We couldn't confirm your payment instantly. If the amount was debited, it will be confirmed automatically within a few minutes — no need to pay again."
    );
    this.name = "PaymentPending";
  }
}

export async function openRazorpayCheckout(
  params: RazorpayOpenParams
): Promise<RazorpaySuccess> {
  const options = {
    key: params.keyId,
    order_id: params.orderId,
    amount: params.amountPaise,
    currency: "INR",
    name: "Havemul",
    description: params.description,
    image: undefined, // Optional: dealer-app logo URL hosted on a CDN
    prefill: params.prefill ?? {},
    theme: params.theme ?? { color: "#1448CC" },
  };

  try {
    const result = await RazorpayCheckout.open(options as any);
    return {
      razorpayPaymentId: result.razorpay_payment_id,
      razorpayOrderId: result.razorpay_order_id,
      razorpaySignature: result.razorpay_signature,
    };
  } catch (err: any) {
    // The SDK rejects with { code, description } shaped errors.
    // Cancel code on Android is 0, iOS is 'PAYMENT_CANCELLED'.
    const code = err?.code ?? err?.error?.code;
    const description = err?.description ?? err?.error?.description ?? "";
    if (
      code === 0 ||
      code === "PAYMENT_CANCELLED" ||
      /cancel/i.test(description)
    ) {
      throw new RazorpayCancelled(description);
    }
    throw new RazorpayFailed(code, description || "Payment failed");
  }
}

/**
 * Convenience: build the prefill from the auth store. Most callers
 * just want `{ contact, name }` from the logged-in dealer.
 */
export function prefillFromDealer(): RazorpayOpenParams["prefill"] {
  const dealer = useAuthStore.getState().dealer;
  if (!dealer) return {};
  return {
    name: dealer.name,
    contact: dealer.phone,
    email: dealer.email ?? undefined,
  };
}