import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { qk } from "../lib/queryKeys";
import { useAuthStore } from "../store/auth";

export interface DealerRoute {
  id: string;
  code: string;
  name: string;
  isPrimary: boolean;
}

/**
 * Returns the list of routes the dealer is assigned to.
 * Used by the Profile screen route-picker.
 */
export function useDealerRoutes() {
  return useQuery<{ routes: DealerRoute[] }>({
    queryKey: ["dealer-routes"],
    queryFn: () => api.get("/api/v1/dealer/routes"),
  });
}

/**
 * Switches the dealer's active (primary) route.
 * Invalidates the route list + window status + refreshes the auth profile
 * so dealer.routeId/routeName update immediately everywhere.
 */
export function useSwitchRoute() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (routeId: string) =>
      api.patch("/api/v1/dealer/route", { routeId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["dealer-routes"] });
      // Invalidate window for every routeId (prefix match)
      qc.invalidateQueries({ queryKey: ["window"] });
      // Refresh the auth store so routeName/routeId update in the header
      useAuthStore.getState().refreshProfile();
    },
  });
}
