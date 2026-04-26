import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { qk } from "../lib/queryKeys";
import type { Banner } from "../lib/types";

interface BannersResponse {
  banners: Array<{
    id: string;
    title: string;
    subtitle: string | null;
    category: string | null;
    image_url: string | null;
    start_date: string;
    end_date: string;
  }>;
}

function normalizeBanner(b: BannersResponse["banners"][number]): Banner {
  return {
    id:        b.id,
    title:     b.title,
    subtitle:  b.subtitle,
    category:  b.category,
    imageUrl:  b.image_url,
    startDate: b.start_date,
    endDate:   b.end_date,
  };
}

/**
 * Marketing banners shown in the PromoBanner horizontal scroll (spec §6.4).
 * Backend filters to `active = true AND start_date ≤ today ≤ end_date`.
 * Cached aggressively — banners rarely change during the day.
 */
export function useBanners() {
  return useQuery<Banner[]>({
    queryKey: qk.banners,
    queryFn: async () => {
      const res = await api.get<BannersResponse>("/api/v1/banners");
      return (res.banners ?? []).map(normalizeBanner);
    },
    staleTime: 15 * 60_000,
    retry: 1,
  });
}