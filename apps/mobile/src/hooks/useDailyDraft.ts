import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import type {
  ConfirmDraftCreditExceeded,
  ConfirmDraftSuccess,
  DailyDraft,
  DraftItem,
} from "../lib/types";

/**
 * useDailyDraft(date) — read the draft for a given delivery date.
 *
 * The server returns either a persisted draft (exists=true) or a
 * synthesized preview from the standing indent (exists=false). The
 * UI treats them the same — the first PATCH materializes the row.
 *
 * Cached per-date for 30s. PATCH and confirm invalidate the same
 * key, so changes propagate immediately.
 */
export function useDailyDraft(date: string | null | undefined) {
  return useQuery({
    queryKey: ["dealer-draft", date],
    enabled: !!date,
    queryFn: async () => {
      return api.get<DailyDraft>(`/api/v1/dealer/drafts/${date}`);
    },
    staleTime: 30 * 1000,
  });
}

/**
 * usePatchDraft — bulk-replace items for a date's draft.
 *
 * Optimistically updates the cache so the +/- feels instant; on
 * server confirmation, the totals refresh. On error, the cache
 * rolls back.
 *
 * Body shape: `{ items: [{ productId, quantity }] }`. Pass quantity=0
 * to remove an item.
 */
export function usePatchDraft(date: string) {
  const qc = useQueryClient();
  const queryKey = ["dealer-draft", date];

  return useMutation({
    mutationFn: async (items: { productId: string; quantity: number }[]) => {
      return api.patch<{
        orderId: string;
        deliveryDate: string;
        status: "draft";
        totals: { subtotal: number; totalGst: number; grandTotal: number };
        itemCount: number;
      }>(`/api/v1/dealer/drafts/${date}`, { items });
    },

    // ── Optimistic update ──
    onMutate: async (items) => {
      await qc.cancelQueries({ queryKey });
      const previous = qc.getQueryData<DailyDraft>(queryKey);

      if (previous) {
        // Rebuild the items list with the requested quantities.
        // For items not in the new list, drop them.
        const qtyMap = new Map(items.map((i) => [i.productId, i.quantity]));
        const newItems: DraftItem[] = previous.items
          .map((it) => {
            const q = qtyMap.get(it.productId);
            if (q === undefined) return it; // unchanged
            if (q <= 0) return null; // removed
            return {
              ...it,
              quantity: q,
              lineTotal:
                Math.round(it.unitPrice * (1 + it.gstPercent / 100) * q * 100) /
                100,
            };
          })
          .filter((x): x is DraftItem => x !== null);

        // Add any net-new items the cache didn't know about (their
        // price/icon will fill in on the server response).
        for (const item of items) {
          if (item.quantity > 0 && !previous.items.some((p) => p.productId === item.productId)) {
            // Skeleton entry — server roundtrip will replace this.
            newItems.push({
              productId: item.productId,
              productName: "…",
              quantity: item.quantity,
              unitPrice: 0,
              gstPercent: 0,
              lineTotal: 0,
              icon: null,
              imageUrl: null,
              unit: "",
            });
          }
        }

        // Recompute totals optimistically
        const subtotal = newItems.reduce(
          (s, i) => s + i.unitPrice * i.quantity,
          0
        );
        const gst = newItems.reduce(
          (s, i) =>
            s + i.unitPrice * i.quantity * (i.gstPercent / 100),
          0
        );

        qc.setQueryData<DailyDraft>(queryKey, {
          ...previous,
          exists: true,
          items: newItems,
          totals: {
            subtotal: Math.round(subtotal * 100) / 100,
            totalGst: Math.round(gst * 100) / 100,
            grandTotal: Math.round((subtotal + gst) * 100) / 100,
          },
        });
      }

      return { previous };
    },

    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(queryKey, ctx.previous);
    },

    onSettled: () => {
      qc.invalidateQueries({ queryKey });
    },
  });
}

/**
 * useConfirmDraft — POST to /confirm.
 *
 * Returns either the success shape OR throws ApiError with the
 * 402 body (credit exceeded). Caller branches on err.status:
 *
 *   try {
 *     const ok = await confirm.mutateAsync({ paymentMode: "credit" });
 *   } catch (err) {
 *     if (err instanceof ApiError && err.status === 402) {
 *       const { credit } = err.body as ConfirmDraftCreditExceeded;
 *       // prompt for top-up or razorpay
 *     }
 *   }
 */
export function useConfirmDraft(date: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: {
      paymentMode: "credit" | "razorpay";
      razorpayPaymentId?: string;
    }) => {
      return api.post<ConfirmDraftSuccess>(
        `/api/v1/dealer/drafts/${date}/confirm`,
        body
      );
    },
    onSuccess: () => {
      // Invalidate the draft so it refetches as "pending"
      qc.invalidateQueries({ queryKey: ["dealer-draft", date] });
      // Profile screen reads outstanding/credit — refresh that too
      qc.invalidateQueries({ queryKey: ["dealer-profile"] });
      // Orders list now has a new pending order
      qc.invalidateQueries({ queryKey: ["my-orders"] });
    },
  });
}

/**
 * Helper: turn a confirm error into the typed credit-exceeded payload
 * so callers don't have to remember the shape.
 */
export function isCreditExceededError(
  err: unknown
): err is ApiError & { body: ConfirmDraftCreditExceeded } {
  return (
    err instanceof ApiError &&
    err.status === 402 &&
    typeof (err as any).body === "object" &&
    (err as any).body?.error === "Credit limit exceeded"
  );
}