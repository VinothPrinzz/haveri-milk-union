import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { qk } from "../lib/queryKeys";
import type { WindowStatus } from "../lib/types";

/**
 * Polls the route's window status every 30s.
 * Returns backend-aligned state: "open" | "warning" | "closed".
 *
 * Calls GET /api/v1/window/status/route/:routeId (new route-keyed endpoint).
 *
 * @param routeId  the dealer's primary routeId (from useAuthStore)
 */
export function useWindowStatus(routeId: string | undefined) {
  return useQuery<WindowStatus>({
    queryKey: qk.window(routeId),
    queryFn: () => api.get<WindowStatus>(`/api/v1/window/status/route/${routeId}`),
    enabled: !!routeId,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    staleTime: 25_000,
    retry: 1,
  });
}
