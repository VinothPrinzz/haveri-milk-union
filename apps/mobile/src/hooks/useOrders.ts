import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { qk } from "../lib/queryKeys";
import type {
  Order,
  OrderStatus,
  PlaceOrderRequest,
  PlaceOrderResponse,
} from "../lib/types";

// ── Shared response shapes ─────────────────────────────────────────────
interface RawOrderItem {
  product_name: string;
  product_id?: string;
  quantity: number;
  unit_price: string;
  gst_percent: string;
  gst_amount?: string;
  line_total: string;
}

interface RawOrder {
  id: string;
  status: OrderStatus;
  payment_mode: "wallet" | "upi" | "credit";
  subtotal: string;
  total_gst: string;
  grand_total: string;
  item_count: number;
  created_at: string;           // ← always string from backend
  items?: RawOrderItem[];
  cancellation_status?: "pending" | "approved" | "rejected" | null;
}

interface PaginatedRawOrders {
  data: RawOrder[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

// Context type for optimistic update
interface CancelOrderContext {
  prev: [unknown, { data: Order[] } | undefined][];
}

function toIsoString(v: unknown): string {
  if (typeof v === "string" && v.length > 0) return v;
  if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString();
  if (typeof v === "number" && !isNaN(v)) return new Date(v).toISOString();
  return ""; // explicit empty → caller decides fallback
}

function normalizeOrder(o: RawOrder): Order {
  return {
    id:          o.id,
    status:      o.status,
    paymentMode: o.payment_mode,
    subtotal:    parseFloat(String(o.subtotal))    || 0,
    totalGst:    parseFloat(String(o.total_gst))   || 0,
    grandTotal:  parseFloat(String(o.grand_total)) || 0,
    itemCount:   Number(o.item_count) || 0,
    createdAt:   toIsoString(o.created_at),
    cancellationStatus: o.cancellation_status ?? null,
    items: (o.items ?? []).map((i) => ({
      productId:  i.product_id,
      productName: i.product_name,
      quantity:   i.quantity,
      unitPrice:  parseFloat(String(i.unit_price))  || 0,
      gstPercent: parseFloat(String(i.gst_percent)) || 0,
      gstAmount:  i.gst_amount ? parseFloat(String(i.gst_amount)) || 0 : undefined,
      lineTotal:  parseFloat(String(i.line_total))  || 0,
    })),
  };
}

// ── GET /orders/my — paginated list of dealer's orders ─────────────────
interface UseMyOrdersOpts {
  page?: number;
  limit?: number;
  status?: OrderStatus;
}

export function useMyOrders(opts: UseMyOrdersOpts = {}) {
  const { page = 1, limit = 20, status } = opts;
  return useQuery({
    queryKey: qk.orders.my(page, limit, status),
    queryFn: async () => {
      const res = await api.get<PaginatedRawOrders>("/api/v1/orders/my", {
        page,
        limit,
        status,
      });
      return {
        data: (res.data ?? []).map(normalizeOrder),
        total: res.total ?? 0,
        page: res.page ?? page,
        limit: res.limit ?? limit,
        totalPages: res.totalPages ?? 0,
      };
    },
    staleTime: 15_000,
    refetchOnWindowFocus: true,
    retry: 1,
  });
}

// ── POST /orders — place indent ────────────────────────────────────────

/**
 * Places a dealer indent.
 *
 * On success: invalidates orders list + dealer profile (wallet balance changed)
 * and clears the caller-provided cart if `onSuccessSideEffect` is given.
 *
 * The guide calls for optimistic UI — the screen can navigate to the
 * OrderConfirmed screen as soon as this resolves; no need to poll `/orders/:id`.
 */
export function usePlaceOrder() {
  const qc = useQueryClient();
  return useMutation<PlaceOrderResponse, Error, PlaceOrderRequest>({
    mutationFn: async (payload) => {
      const res = await api.post<Record<string, unknown> & { order?: RawOrder }>(
        "/api/v1/orders",
        payload
      );
      const raw = (res.order ?? res) as RawOrder;
      return {
        order: normalizeOrder(raw),
        invoiceNumber: (res as { invoiceNumber?: string }).invoiceNumber,
      };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.orders.all });
      qc.invalidateQueries({ queryKey: qk.invoices.all });
      qc.invalidateQueries({ queryKey: qk.profile });
      qc.invalidateQueries({ queryKey: qk.products });
    },
  });
}

// ── POST /orders/:id/cancel — dealer cancellation request ──────────────
export function useCancelOrder() {
  const qc = useQueryClient();

  return useMutation<
    { message: string; cancellationRequest: unknown },
    Error,
    { orderId: string; reason: string },
    CancelOrderContext          // ← Explicit context type
  >({
    mutationFn: ({ orderId, reason }) =>
      api.post(`/api/v1/orders/${orderId}/cancel`, { reason }),

    onMutate: async ({ orderId }) => {
      await qc.cancelQueries({ queryKey: qk.orders.all });

      const prev = qc.getQueriesData<{ data: Order[] }>({ queryKey: qk.orders.all });

      for (const [key, data] of prev) {
        if (!data?.data) continue;
        qc.setQueryData(key, {
          ...data,
          data: data.data.map((o) =>
            o.id === orderId
              ? { ...o, cancellationStatus: "pending" as const }
              : o
          ),
        });
      }

      return { prev };   // ← Now properly typed
    },

    onError: (_err, _vars, ctx) => {
      // Fixed: ctx is now typed as CancelOrderContext | undefined
      if (ctx?.prev) {
        for (const [key, data] of ctx.prev) {
          qc.setQueryData(key, data);
        }
      }
    },

    onSettled: () => {
      qc.invalidateQueries({ queryKey: qk.orders.all });
    },
  });
}

// ── POST /orders/reorder/:id — populate cart from an old order ─────────

interface ReorderResponse {
  items: Array<{
    productId: string;
    quantity: number;
    unitPrice: number;
    gstPercent: number;
  }>;
  message: string;
}

/**
 * Returns items from a previous order that are still available + in stock.
 * The screen/component is responsible for pushing these into the cart store.
 */
export function useReorder() {
  return useMutation<ReorderResponse, Error, string>({
    mutationFn: (orderId) => api.post<ReorderResponse>(`/api/v1/orders/reorder/${orderId}`),
  });
}