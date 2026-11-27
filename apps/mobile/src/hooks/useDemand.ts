import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert } from "react-native";
import { api } from "../lib/api";
import { qk } from "../lib/queryKeys";

/**
 * "Notify" on an out-of-stock product: tells the union this dealer wants it
 * (POST /api/v1/dealer/products/:id/notify-demand). Staff see it in the
 * admin web's bell and on Sales → Product Demand.
 *
 * useNotifiedToday() lists the products this dealer already asked for today,
 * so their cards show "Notified" instead of the button.
 */
export function useNotifiedToday() {
  return useQuery<Set<string>>({
    queryKey: qk.demandToday,
    queryFn: async () => {
      const res = await api.get<{ productIds: string[] }>("/api/v1/dealer/demand-requests");
      return new Set(res.productIds ?? []);
    },
    staleTime: 60_000,
  });
}

export function useNotifyDemand() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (productId: string) =>
      api.post<{ ok: boolean; message?: string }>(`/api/v1/dealer/products/${productId}/notify-demand`, {}),
    onSuccess: (res, productId) => {
      qc.setQueryData<Set<string>>(qk.demandToday, (prev) => new Set([...(prev ?? []), productId]));
      Alert.alert("Union notified", res?.message ?? "The union has been told you need this product.");
    },
    onError: () => {
      Alert.alert("Couldn't notify", "Please check your connection and try again.");
    },
  });
}
