import { useQuery } from "@tanstack/react-query";
import { api, API_BASE } from "../lib/api";
import { qk } from "../lib/queryKeys";
import type { Invoice, InvoiceSummary, OrderStatus } from "../lib/types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Linking } from "react-native";

interface InvoiceByOrderResponse {
  invoice: {
    id?: string;
    invoice_number?: string;
    total_amount?: string;
  };
  openableUrl: string | null;   // External (R2) URL, if any
  apiPath: string | null;        // Relative path on this API (with token)
}

interface RawInvoice {
  id: string;
  order_id: string;
  invoice_number: string;
  invoice_date: string;
  invoice_date_ist?: string;   // NEW
  month_id?: string;           // NEW: "YYYY-MM" computed by API in IST
  taxable_amount: string;
  cgst: string;
  sgst: string;
  total_tax: string;
  total_amount: string;
  pdf_url: string | null;
  item_count: number;
  order_status: OrderStatus;
}

interface RawSummary {
  total_orders: string;
  total_gst: string;
  invoice_count: number;
  current_month_id?: string;   // NEW
}

interface MyInvoicesResponse {
  invoices: RawInvoice[];
  summary: RawSummary;
}

function normalizeInvoice(r: RawInvoice): Invoice {
  return {
    id:            r.id,
    orderId:       r.order_id,
    invoiceNumber: r.invoice_number,
    invoiceDate:   r.invoice_date_ist ?? r.invoice_date,
    monthId:       r.month_id ?? deriveMonthId(r.invoice_date),  // NEW
    taxableAmount: parseFloat(r.taxable_amount),
    cgst:          parseFloat(r.cgst),
    sgst:          parseFloat(r.sgst),
    totalTax:      parseFloat(r.total_tax),
    totalAmount:   parseFloat(r.total_amount),
    pdfUrl:        r.pdf_url,
    itemCount:     r.item_count,
    orderStatus:   r.order_status,
  };
}

// Fallback if the API hasn't been redeployed yet
function deriveMonthId(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function normalizeSummary(s: RawSummary | undefined): InvoiceSummary {
  return {
    totalOrders:    s ? parseFloat(s.total_orders) : 0,
    totalGst:       s ? parseFloat(s.total_gst)    : 0,
    invoiceCount:   s ? s.invoice_count : 0,
    currentMonthId: s?.current_month_id,            // NEW
  };
}

/**
 * Dealer's own invoices + current-month summary (spec §5.4).
 *
 * Backend endpoint returns the latest 50 invoices (no pagination yet).
 * The UI filters/groups by month client-side using `invoiceDate`.
 */
export function useMyInvoices(opts?: { pollWhilePending?: boolean }) {
  return useQuery({
    queryKey: qk.invoices.my,
    queryFn: async () => {
      const res = await api.get<MyInvoicesResponse>("/api/v1/invoices/my");
      return {
        invoices: (res.invoices ?? []).map(normalizeInvoice),
        summary:  normalizeSummary(res.summary),
      };
    },
    refetchInterval: opts?.pollWhilePending ? 3_000 : false,
  });
}

/**
 * Fetches the openable URL for an invoice (generating if needed).
 * Returns the absolute HTTPS URL the mobile can pass to Linking.openURL.
 */
export function useInvoiceByOrder() {
  const qc = useQueryClient();
  return useMutation<string, Error, string>({
    mutationFn: async (orderId) => {
      const res = await api.get<InvoiceByOrderResponse>(
        `/api/v1/dealer/invoices/by-order/${orderId}`
      );
      // Prefer external URL; fall back to building from API_BASE + apiPath.
      const url = res.openableUrl
        ?? (res.apiPath ? `${API_BASE}${res.apiPath}` : null);
      if (!url) throw new Error("No invoice URL returned");
      return url;
    },
    onSuccess: () => {
      // The invoice row is now guaranteed to exist — refresh the list
      // so the GST page reflects it without waiting for the next focus.
      qc.invalidateQueries({ queryKey: qk.invoices.all });
    },
  });
}

export function useBulkInvoiceDownload() {
  return useMutation<string, Error, string[]>({
    mutationFn: async (orderIds) => {
      if (orderIds.length === 0) throw new Error("No invoices selected");
      const res = await api.get<{ apiPath: string }>(
        `/api/v1/dealer/invoices/bulk`,
        { orderIds: orderIds.join(",") }
      );
      return `${API_BASE}${res.apiPath}`;
    },
  });
}