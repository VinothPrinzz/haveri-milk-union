/**
 * Centralized TanStack Query cache keys.
 *
 * Every hook in `src/hooks/` imports from here so invalidation stays
 * consistent. Hardcoding key arrays in individual hooks is exactly how
 * the "Orders tab doesn't refresh after placing an order" bug happened:
 * useMyOrders registered under ["orders","my",...] while useConfirmDraft
 * and useOrderPayment invalidated a different, non-matching ["my-orders"]
 * array. Always invalidate through `qk` so prefixes line up.
 *
 *   queryClient.invalidateQueries({ queryKey: qk.orders.all })
 *
 * NOTE: the dealer profile (credit limit, wallet, outstanding) does NOT
 * live in the query cache — it lives in the Zustand `useAuthStore`. There
 * is therefore no profile query to invalidate; to refresh it after a
 * mutation call `useAuthStore.getState().refreshProfile()` instead.
 * `qk.profile` is kept only for the (currently unused) case of moving the
 * profile into React Query later.
 */

export const qk = {
  // Window status — polled every 30s
  window: (zoneId: string | undefined) => ["window", zoneId ?? "none"] as const,

  // Catalog (products, categories, banners)
  products:   ["products"] as const,
  categories: ["categories"] as const,
  banners:    ["banners"] as const,

  // Dealer's own profile — see NOTE above (lives in Zustand, not RQ).
  profile: ["dealer", "profile"] as const,

  // Orders — list + single.
  // `all` is the canonical prefix: invalidating it matches every
  // paginated/filtered `my(...)` variant by prefix.
  orders: {
    all:    ["orders"] as const,
    my: (limit: number, status?: string, from?: string, to?: string) =>
      ["orders", "my", { limit, status, from, to }] as const,
    detail: (id: string) => ["orders", "detail", id] as const,
  },

  // Daily draft / standing-indent preview, keyed per delivery date.
  // `all` invalidates every date at once (used after place/confirm/pay).
  draft: {
    all:    ["dealer-draft"] as const,
    byDate: (date: string | null | undefined) =>
              ["dealer-draft", date] as const,
  },

  // Razorpay payment history (Profile screen).
  payments: ["razorpay-payments"] as const,

  // Invoices
  invoices: {
    all: ["invoices"] as const,
    my:  ["invoices", "my"] as const,
  },
} as const;