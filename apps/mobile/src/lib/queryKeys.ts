/**
 * Centralized TanStack Query cache keys.
 *
 * Every hook in `src/hooks/` imports from here so invalidation stays consistent.
 * When you want to refetch orders after placing one, call:
 *     queryClient.invalidateQueries({ queryKey: qk.orders.all })
 */

export const qk = {
    // Window status — polled every 30s
    window: (zoneId: string | undefined) => ["window", zoneId ?? "none"] as const,
  
    // Catalog (products, categories, banners)
    products:   ["products"] as const,
    categories: ["categories"] as const,
    banners:    ["banners"] as const,
  
    // Dealer's own profile
    profile: ["dealer", "profile"] as const,
  
    // Orders — list + single
    orders: {
      all:             ["orders"] as const,
      my:              (page: number, limit: number, status?: string) =>
                         ["orders", "my", { page, limit, status }] as const,
      detail:          (id: string) => ["orders", "detail", id] as const,
    },
  
    // Invoices
    invoices: {
      all: ["invoices"] as const,
      my:  ["invoices", "my"] as const,
    },
  } as const;