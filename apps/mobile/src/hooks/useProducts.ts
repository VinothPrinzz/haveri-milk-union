import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { qk } from "../lib/queryKeys";
import type { Product, Category } from "../lib/types";

// ── Products ───────────────────────────────────────────────────────────

interface ProductsResponse {
  products: Array<
    Omit<Product, "basePrice" | "gstPercent" | "stock" | "sortOrder"
      | "retailDealerPrice" | "creditInstMrpPrice" | "creditInstDealerPrice" | "parlourDealerPrice"
      | "packetsCrate"> & {
      basePrice: string;
      gstPercent: string;
      stock: number;
      sortOrder: number;
      retailDealerPrice?: string;
      creditInstMrpPrice?: string;
      creditInstDealerPrice?: string;
      parlourDealerPrice?: string;
      packetsCrate?: number;
    }
  >;
}

function normalizeProduct(p: ProductsResponse["products"][number]): Product {
  return {
    ...p,
    basePrice:  parseFloat(p.basePrice),
    gstPercent: parseFloat(p.gstPercent),
    retailDealerPrice:      p.retailDealerPrice      ? parseFloat(p.retailDealerPrice)      : undefined,
    creditInstMrpPrice:     p.creditInstMrpPrice     ? parseFloat(p.creditInstMrpPrice)     : undefined,
    creditInstDealerPrice:  p.creditInstDealerPrice  ? parseFloat(p.creditInstDealerPrice)  : undefined,
    parlourDealerPrice:     p.parlourDealerPrice     ? parseFloat(p.parlourDealerPrice)     : undefined,
  };
}

/**
 * All active products (backend filters `deleted_at IS NULL AND available = true`).
 * Cached for 5 minutes — product prices don't change mid-window.
 */
export function useProducts() {
  return useQuery<Product[]>({
    queryKey: qk.products,
    queryFn: async () => {
      const res = await api.get<ProductsResponse>("/api/v1/products");
      return (res.products ?? []).map(normalizeProduct);
    },
    staleTime: 5 * 60_000,
    retry: 1,
  });
}

// ── Categories ─────────────────────────────────────────────────────────

interface CategoriesResponse { categories: Category[] }

export function useCategories() {
  return useQuery<Category[]>({
    queryKey: qk.categories,
    queryFn: async () => {
      const res = await api.get<CategoriesResponse>("/api/v1/categories");
      return res.categories ?? [];
    },
    staleTime: 10 * 60_000,
    retry: 1,
  });
}