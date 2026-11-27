// apps/web/src/pages/contractor-entries/shared.tsx
// Shared bits for the Contractor Entries pages: who may record, labels, the status pill.
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { fmtNum } from "@/components/PageHeader";
import type { EntryStatus, EntryType } from "@/services/officerEntries";

// Mirrors officer_entries.manage in apps/api/src/middleware/admin-auth.ts
// (super_admin and call_desk are super roles there).
const MANAGE = ["super_admin", "call_desk", "officer"];
export function useCanRecordEntries(): boolean {
  const { user } = useAuth();
  return MANAGE.includes(user?.role ?? "");
}

export const TYPE_LABEL: Record<EntryType, string> = {
  short_supply: "Short supply",
  crate_shortage: "Crate shortage",
  product_shortage: "Product shortage",
  km_short: "Km short",
  extra_km: "Extra km",
  extra_trip: "Extra trip",
  penalty: "Penalty",
};

export const REPORT_SOURCE_LABEL: Record<string, string> = {
  customer_call: "Customer phoned",
  officer_visit: "Found on visit",
  dispatch_check: "Dispatch check",
  return_check: "Return check",
  on_route: "On the route",
};

export const PENALTY_REASONS: { value: string; label: string }[] = [
  { value: "late_arrival", label: "Late arrival (over 1 hour)" },
  { value: "not_clean", label: "Vehicle or crates not clean" },
  { value: "misbehaviour", label: "Misbehaviour with customer" },
  { value: "other", label: "Other" },
];

export const STATUS_LABEL: Record<EntryStatus, string> = {
  not_on_bill: "Not on bill yet",
  on_bill: "On bill · Draft",
  removed: "Removed from bill",
  locked: "Locked",
};

export function EntryStatusPill({ status, className }: { status: EntryStatus; className?: string }) {
  const tone = {
    not_on_bill: "bg-muted text-muted-foreground",
    on_bill: "bg-info/15 text-info",
    removed: "bg-warning/15 text-warning",
    locked: "bg-success/15 text-success",
  }[status];
  return (
    <span className={cn("inline-block rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap", tone, className)}>
      {STATUS_LABEL[status]}
    </span>
  );
}

/** ₹ with two decimals and Indian grouping. */
export const money = (n: number | null | undefined) => `₹${fmtNum(Number(n) || 0, 2)}`;
/** Signed: − for deductions, + for additions. */
export const signedMoney = (kind: "earning" | "deduction", n: number) => `${kind === "deduction" ? "−" : "+"}${money(n)}`;
export const qtyText = (n: number | null | undefined) =>
  (Number(n) || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });
