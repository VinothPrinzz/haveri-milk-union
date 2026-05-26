import { useInfiniteQuery } from "@tanstack/react-query";
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
export function usePaymentHistory(limit = 20) {
  return useInfiniteQuery({
    queryKey: ["razorpay-payments", limit],
    queryFn: async ({ pageParam }) => {
      const res = await api.get<{
        payments: RazorpayPaymentRow[]; page: number; totalPages: number;
      }>("/api/v1/dealer/razorpay-payments", { page: pageParam, limit });
      return {
        payments: (res.payments ?? []).map((p) => ({
          ...p,
          amount: typeof p.amount === "string" ? parseFloat(p.amount) : p.amount,
        })),
        page: res.page,
        totalPages: res.totalPages,
      };
    },
    initialPageParam: 1,
    getNextPageParam: (last) =>
      last.page < last.totalPages ? last.page + 1 : undefined,
    select: (d) => ({ rows: d.pages.flatMap((p) => p.payments) }),
    staleTime: 60_000,
  });
}