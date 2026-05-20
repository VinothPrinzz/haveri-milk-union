import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type {
  EligibleProduct,
  StandingIndentItem,
} from "../lib/types";

/**
 * useStandingIndent — read the dealer's standing template.
 *
 * Use on the "Manage standing indent" screen and as a fallback
 * source for IndentScreen's synthesized draft preview.
 *
 * Cached for 5 minutes — the standing indent rarely changes between
 * sessions, and PUT invalidates this query on success.
 */
function normalizeItem(item: any): StandingIndentItem {
  return {
    ...item,
    basePrice:  parseFloat(item.basePrice  ?? item.base_price  ?? 0) || 0,
    gstPercent: parseFloat(item.gstPercent ?? item.gst_percent ?? 0) || 0,
  };
}

export function useStandingIndent() {
  return useQuery({
    queryKey: ["standing-indents"],
    queryFn: async () => {
      const res = await api.get<{ items: any[] }>(
        "/api/v1/dealer/standing-indents"
      );
      return (res.items ?? []).map(normalizeItem);
    },
    staleTime: 5 * 60 * 1000,
  });
}

/**
 * useEligibleProducts — products the dealer COULD add to their
 * standing indent (admin set make_zero_in_indents=false). Used by
 * the "Manage standing indent" picker.
 *
 * Each row tells you what the dealer's CURRENT default_qty + active
 * are, so the picker can render checkboxes/quantity steppers
 * pre-populated.
 */
function normalizeEligible(item: any): EligibleProduct {
  return {
    ...item,
    basePrice:  parseFloat(item.basePrice  ?? item.base_price  ?? 0) || 0,
    gstPercent: parseFloat(item.gstPercent ?? item.gst_percent ?? 0) || 0,
  };
}

export function useEligibleProducts() {
  return useQuery({
    queryKey: ["standing-indents", "eligible"],
    queryFn: async () => {
      const res = await api.get<{ items: any[] }>(
        "/api/v1/dealer/standing-indents/eligible"
      );
      return (res.items ?? []).map(normalizeEligible);
    },
    staleTime: 5 * 60 * 1000,
  });
}

/**
 * useUpdateStandingIndent — bulk PUT the dealer's standing template.
 *
 * On success, invalidates:
 *   • the standing-indents query (refetches the new state)
 *   • all daily-draft queries (the next draft.get will re-synthesize
 *     from the updated template, if the dealer hasn't customized
 *     that date's draft yet)
 */
export function useUpdateStandingIndent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (
      items: { productId: string; defaultQty: number; active: boolean }[]
    ) => {
      return api.put<{ updated: number }>(
        "/api/v1/dealer/standing-indents",
        { items }
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["standing-indents"] });
      qc.invalidateQueries({ queryKey: ["dealer-draft"] });
    },
  });
}