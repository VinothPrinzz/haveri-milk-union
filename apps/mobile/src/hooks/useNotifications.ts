import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

export interface DealerNotification {
  id: string;
  title: string;
  message: string;
  channel: "push" | "sms" | "email";
  status: string;
  created_at: string;
  unread?: boolean;
}

export const notificationsKey = ["dealer", "notifications"] as const;

export function useNotifications() {
  return useQuery({
    queryKey: notificationsKey,
    queryFn: async () => {
      const res = await api.get<{ notifications: DealerNotification[] }>(
        "/api/v1/dealer/notifications"
      );
      return res.notifications ?? [];
    },
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

export function useMarkNotificationRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post(`/api/v1/dealer/notifications/${id}/read`),
    onSuccess: () => qc.invalidateQueries({ queryKey: notificationsKey }),
  });
}