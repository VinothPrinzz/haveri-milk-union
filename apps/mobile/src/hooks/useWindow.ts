import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { qk } from "../lib/queryKeys";
import type { WindowStatus } from "../lib/types";

/**
 * Polls the zone's window status every 30s (spec §2 Window: "polled every 30 seconds
 * during the window"). Returns backend-aligned state: "open" | "warning" | "closed".
 *
 * @param zoneId  the dealer's zoneId (from useAuthStore)
 */
export function useWindowStatus(zoneId: string | undefined) {
  return useQuery<WindowStatus>({
    queryKey: qk.window(zoneId),
    queryFn: () => api.get<WindowStatus>(`/api/v1/window/status/${zoneId}`),
    enabled: !!zoneId,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    staleTime: 25_000,
    retry: 1,
  });
}