import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

export interface RazorpayPaymentRow {
  id: string;
  razorpayOrderId: string;
  razorpayPaymentId: string | null;
  amount: number;
  currency: string;
  kind: "credit_topup" | "order_payment";
  status: "created" | "attempted" | "paid" | "failed" | "refunded";
  orderId: string | null;
  paidAt: string | null;
  createdAt: string;
  errorDescription: string | null;
}

/**
 * usePaymentHistory — last 50 Razorpay transactions for the dealer.
 *
 * Used by the Profile screen's payment history section. Refetched
 * when a fresh top-up or pay-now succeeds (the credit-topup and
 * pay-now mutations invalidate `["razorpay-payments"]`).
 */
export function usePaymentHistory() {
  return useQuery({
    queryKey: ["razorpay-payments"],
    queryFn: async () => {
      const res = await api.get<{ payments: RazorpayPaymentRow[] }>(
        "/api/v1/dealer/razorpay-payments"
      );
      return res.payments;
    },
    staleTime: 60 * 1000,
  });
}