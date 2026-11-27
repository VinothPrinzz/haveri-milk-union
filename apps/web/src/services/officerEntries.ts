// apps/web/src/services/officerEntries.ts
// ══════════════════════════════════════════════════════════════════
// Contractor entries recorded by route officers (short supply, crate /
// product shortage, short km, extra km / trips, penalties). Backend:
// apps/api/src/routes/officer-entries.ts. Each entry becomes a line on its
// route's monthly DTC bill.
// ══════════════════════════════════════════════════════════════════
import { get, post, patch, del } from "@/lib/apiClient";
import type { BillingType } from "@/services/dtc";

export type EntryType =
  | "short_supply" | "crate_shortage" | "product_shortage" | "km_short" | "extra_km" | "extra_trip" | "penalty";
export type EntryStatus = "not_on_bill" | "on_bill" | "removed" | "locked";
export type ReportSource = "customer_call" | "officer_visit" | "dispatch_check" | "return_check" | "on_route";
export type Shift = "morning" | "evening";

export interface EntryItem { productId: string; name: string; qty: number; rate: number; amount: number }

export interface OfficerEntry {
  id: string; entryDate: string; month: string; shift: Shift; type: EntryType;
  kind: "earning" | "deduction"; head: string; headLabel: string; detail: string;
  routeId: string; routeCode: string; routeName: string;
  contractorId: string | null; contractorName: string | null;
  dealerId: string | null; dealerCode: string | null; dealerName: string | null;
  reportSource: ReportSource | null; items: EntryItem[];
  cratesSent: number | null; cratesReturned: number | null;
  qty: number | null; unit: "km" | "trip" | "crate" | "packet" | null; rate: number | null;
  kmExpected: number | null; kmRun: number | null; amount: number;
  reason: string | null; reference: string | null; remarks: string | null; photoUrl: string | null;
  createdAt: string; createdByName: string | null; updatedAt: string; updatedByName: string | null;
  status: EntryStatus; locked: boolean; runStatus: string | null; billId: string | null;
}

export interface EntryTotals { count: number; deductions: number; additions: number; notOnBill: number }

export const fetchOfficerEntries = (q: { month: string; routeId?: string; type?: string; q?: string }) =>
  get<{ month: string; totals: EntryTotals; data: OfficerEntry[] }>("/officer-entries", {
    month: q.month, routeId: q.routeId || undefined, type: q.type || undefined, q: q.q || undefined,
  });
export const fetchOfficerEntry = (id: string) => get<{ entry: OfficerEntry }>(`/officer-entries/${id}`);

export interface EntryRoute {
  id: string; code: string; name: string;
  contractorId: string | null; contractorName: string | null; contractorPhone: string | null;
  vehicleNumber: string | null;
  terms: { billingType: BillingType; rate: number; kmPerDay: number; perKmRate: number | null; effectiveFrom: string } | null;
}
export interface EntryProduct { id: string; code: string | null; name: string; fullName: string; unit: string; price: number }
export interface EntryLookups {
  date: string; runStatus: string | null; routes: EntryRoute[]; crateRate: number; products: EntryProduct[];
}
export const fetchEntryLookups = (date: string) => get<EntryLookups>("/officer-entries/lookups", { date });

export interface EntryDealer { id: string; code: string | null; name: string; phone: string | null }
export const fetchRouteDealers = async (routeId: string) =>
  (await get<{ data: EntryDealer[] }>("/officer-entries/lookups/dealers", { routeId })).data;

export interface EntryInput {
  entryDate: string; routeId: string; shift: Shift; type: EntryType;
  dealerId?: string | null; reportSource?: ReportSource | null;
  items?: { productId: string; qty: number }[] | null;
  cratesSent?: number | null; cratesReturned?: number | null;
  kmRun?: number | null; qty?: number | null; amount?: number | null;
  reason?: string | null; reference?: string | null; remarks?: string | null; photoUrl?: string | null;
}
export const createOfficerEntry = (body: EntryInput) =>
  post<{ message: string; entry: OfficerEntry }>("/officer-entries", body);
export const updateOfficerEntry = (id: string, body: EntryInput) =>
  patch<{ message: string; entry: OfficerEntry }>(`/officer-entries/${id}`, body);
export const deleteOfficerEntry = (id: string) => del<{ message: string }>(`/officer-entries/${id}`);

/** Upload a photo straight to storage; returns the URL to save on the entry. */
export async function uploadEntryPhoto(file: File): Promise<string> {
  const type = file.type as "image/jpeg" | "image/png" | "image/webp";
  if (!["image/jpeg", "image/png", "image/webp"].includes(type)) throw new Error("Use a JPG, PNG or WebP photo.");
  const { uploadUrl, publicUrl } = await post<{ uploadUrl: string; publicUrl: string }>(
    "/officer-entries/photo-presign", { filename: file.name, contentType: type });
  const res = await fetch(uploadUrl, { method: "PUT", body: file, headers: { "Content-Type": type } });
  if (!res.ok) throw new Error("Photo upload failed");
  return publicUrl;
}
