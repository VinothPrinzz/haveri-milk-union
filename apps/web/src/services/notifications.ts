// apps/web/src/services/notifications.ts
// Staff notifications (the top-bar bell) and dealers' product demand.
import { get, post } from "@/lib/apiClient";

export interface StaffNotification {
  id: string;
  kind: "product_demand" | "officer_shortage" | string;
  title: string;
  body: string | null;
  link: string | null;
  createdAt: string;
  read: boolean;
}
export const fetchStaffNotifications = () =>
  get<{ data: StaffNotification[]; unread: number }>("/admin-notifications");
export const markStaffNotificationRead = (id: string) =>
  post<{ ok: boolean }>(`/admin-notifications/${id}/read`, {});
export const markAllStaffNotificationsRead = () =>
  post<{ ok: boolean }>("/admin-notifications/read-all", {});

export interface DemandRequest {
  id: string; requestDate: string; taps: number; createdAt: string; updatedAt: string;
  resolvedAt: string | null; resolvedByName: string | null;
  dealerId: string; dealerCode: string | null; dealerName: string; dealerPhone: string | null;
  taluka: string; routeCode: string | null;
}
export interface DemandProduct {
  productId: string; productCode: string | null; productName: string; categoryName: string;
  dealerCount: number; taps: number; open: number; requests: DemandRequest[];
}
export const fetchProductDemand = (params: { from: string; to: string; status: "open" | "all" }) =>
  get<{ from: string; to: string; status: string; products: DemandProduct[] }>("/product-demand", params);
export const resolveProductDemand = (ids: string[]) =>
  post<{ resolved: number }>("/product-demand/resolve", { ids });
