import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import {
  openRazorpayCheckout,
  prefillFromDealer,
  PaymentPending,
  RazorpayCancelled,
  RazorpayFailed,
} from "../lib/razorpay";
import { verifyPayment } from "../lib/payments";
import { useAuthStore } from "../store/auth";

/**
 * useCreditTopUp — one-shot mutation that does the entire top-up flow:
 *
 *   1. Server creates a Razorpay order        (POST /credit-topup/order)
 *   2. Mobile opens Razorpay checkout sheet
 *   3. User pays
 *   4. Server verifies the signature           (POST /credit-topup/verify)
 *   5. Caches invalidated so UI reflects new credit
 *
 * On cancel/failure, throws RazorpayCancelled / RazorpayFailed
 * respectively — callers can branch on `instanceof` to show different
 * toasts.
 *
 *   const topUp = useCreditTopUp();
 *   await topUp.mutateAsync({ amount: 5000 });
 */
export function useCreditTopUp() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ amount }: { amount: number }) => {
      // 1. Create the Razorpay order server-side
      const created = await api.post<{
        razorpayOrderId: string;
        amount: number;
        amountPaise: number;
        currency: string;
        keyId: string;
      }>("/api/v1/dealer/credit-topup/order", { amount });

      // 2. Open the SDK sheet
      const result = await openRazorpayCheckout({
        keyId: created.keyId,
        amountPaise: created.amountPaise,
        orderId: created.razorpayOrderId,
        description: `Top up wallet by ₹${amount}`,
        prefill: prefillFromDealer(),
      });

      // 3. Verify server-side.
      // Throws PaymentPending on 202/timeout (money may be captured, the
      // backend will auto-credit) — callers must show "confirming…",
      // never "failed" or a credited balance.
      const verified = await verifyPayment<{
        ok: true;
        alreadyApplied: boolean;
        amount: number;
      }>("/api/v1/dealer/credit-topup/verify", {
        razorpayOrderId: result.razorpayOrderId,
        razorpayPaymentId: result.razorpayPaymentId,
        razorpaySignature: result.razorpaySignature,
      });

      return { ...verified, paidAmount: amount };
    },

    onSuccess: () => {
      // Outstanding + available credit changed
      qc.invalidateQueries({ queryKey: ["dealer-profile"] });
      // Future drafts' credit checks will use the new available credit
      qc.invalidateQueries({ queryKey: ["dealer-draft"] });
      // Payment history list
      qc.invalidateQueries({ queryKey: ["razorpay-payments"] });
      useAuthStore.getState().refreshProfile();
    },
  });
}

export { PaymentPending, RazorpayCancelled, RazorpayFailed };