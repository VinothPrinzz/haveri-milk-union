import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { qk } from "../lib/queryKeys";
import {
  openRazorpayCheckout,
  prefillFromDealer,
  RazorpayCancelled,
  RazorpayFailed,
} from "../lib/razorpay";
import { useAuthStore } from "../store/auth";

/**
 * useOrderPayment — pay for a specific order via Razorpay.
 *
 * Used when the dealer hits "Pay this order now" — either from the
 * credit-exceeded alert in IndentScreen.handleConfirm, or from the
 * payment-required banner shown when looking at an existing order.
 *
 *   const pay = useOrderPayment(orderId);
 *   await pay.mutateAsync();
 *
 * On success the order transitions to 'confirmed' server-side, which
 * the draft / orders queries pick up via invalidation.
 *
 * The hook factory takes orderId so the mutation has no input — the
 * call site is simpler than passing orderId through every mutate.
 */
export function useOrderPayment(orderId: string) {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      // 1. Create the Razorpay order server-side
      const created = await api.post<{
        razorpayOrderId: string;
        amount: number;
        amountPaise: number;
        currency: string;
        keyId: string;
        orderId: string;
      }>(`/api/v1/dealer/orders/${orderId}/pay-now`, {});

      // 2. Open the SDK sheet
      const result = await openRazorpayCheckout({
        keyId: created.keyId,
        amountPaise: created.amountPaise,
        orderId: created.razorpayOrderId,
        description: `Order payment · ₹${Number(created.amount).toFixed(2)}`,
        prefill: prefillFromDealer(),
      });

      // 3. Verify server-side — also flips order to 'confirmed'
      const verified = await api.post<{
        ok: true;
        alreadyApplied: boolean;
        orderId: string | null;
      }>(`/api/v1/dealer/orders/${orderId}/pay-now/verify`, {
        razorpayOrderId: result.razorpayOrderId,
        razorpayPaymentId: result.razorpayPaymentId,
        razorpaySignature: result.razorpaySignature,
      });

      return { ...verified, paidAmount: created.amount };
    },

    onSuccess: () => {
      // The drafts query for this date now shows the order as confirmed.
      qc.invalidateQueries({ queryKey: qk.draft.all });
      // Orders list. MUST be qk.orders.all — the old ["my-orders"] key
      // did not match the ["orders","my",...] key useMyOrders uses, so
      // the Orders tab silently failed to refresh after a pay-now.
      qc.invalidateQueries({ queryKey: qk.orders.all });
      // Payment history list on the Profile screen.
      qc.invalidateQueries({ queryKey: qk.payments });
      // Refresh the Zustand profile (credit / outstanding may change).
      useAuthStore.getState().refreshProfile();
    },
  });
}

export { RazorpayCancelled, RazorpayFailed };