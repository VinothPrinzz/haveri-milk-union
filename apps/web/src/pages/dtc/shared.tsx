// apps/web/src/pages/dtc/shared.tsx
// Shared bits for the DTC Billing pages: who may do what, labels, formats.
import type { ReactNode } from "react";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { fmtNum } from "@/components/PageHeader";
import type { BillingType, RunStatus, PayMode } from "@/services/dtc";

// Mirrors the dtc.* permissions in apps/api/src/middleware/admin-auth.ts
// (super_admin and call_desk are super roles there).
const SUPER = ["super_admin", "call_desk"];
const PERMS = {
  setup:          ["manager", "accountant"],
  prepare:        ["manager"],
  audit:          ["accountant"],
  approveMktg:    ["manager"],
  approveFinance: ["accountant"],
  pay:            ["accountant"],
} as const;
export type DtcPerm = keyof typeof PERMS;

export function useDtcPerms(): Record<DtcPerm, boolean> {
  const { user } = useAuth();
  const role = user?.role ?? "";
  const can = (p: DtcPerm) => SUPER.includes(role) || (PERMS[p] as readonly string[]).includes(role);
  return {
    setup: can("setup"), prepare: can("prepare"), audit: can("audit"),
    approveMktg: can("approveMktg"), approveFinance: can("approveFinance"), pay: can("pay"),
  };
}

export const BILLING_TYPE_LABEL: Record<BillingType, string> = { km: "KM", trip: "TRIP", litre: "LTR / KG" };
export const RATE_UNIT: Record<BillingType, string> = { km: "per km", trip: "per trip", litre: "per litre/kg" };

export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  draft: "Draft",
  submitted: "Waiting pre-audit",
  pre_audited: "Waiting Marketing approval",
  mktg_approved: "Waiting Finance approval",
  approved: "Approved",
};

export const EARNING_HEADS: { head: string; label: string; unit?: string; usesBillRate?: BillingType }[] = [
  { head: "extra_km", label: "Extra km", unit: "km", usesBillRate: "km" },
  { head: "extra_trip", label: "Extra trips", unit: "trips", usesBillRate: "trip" },
  { head: "extra_litre", label: "Extra litres", unit: "litres", usesBillRate: "litre" },
  { head: "other_earning", label: "Other earning" },
];
export const DEDUCTION_HEADS: { head: string; label: string; unit?: string; usesBillRate?: BillingType; usesCrateRate?: boolean }[] = [
  { head: "crate", label: "Crate shortage", unit: "crates", usesCrateRate: true },
  { head: "packet", label: "Packet / product shortage", unit: "packets" },
  { head: "km", label: "Short km", unit: "km", usesBillRate: "km" },
  { head: "dues", label: "Dues" },
  { head: "penalty", label: "Penalty (vehicle not reported / late / substitute)" },
  { head: "security_deposit", label: "Security deposit" },
  { head: "gps", label: "GPS" },
  { head: "advance", label: "Advance recovery" },
  { head: "tds", label: "TDS" },
  { head: "other_deduction", label: "Other deduction" },
];
export const HEAD_LABEL: Record<string, string> = {
  ...Object.fromEntries(EARNING_HEADS.map(h => [h.head, h.label])),
  ...Object.fromEntries(DEDUCTION_HEADS.map(h => [h.head, h.label])),
  penalty: "Penalty",
  carry_forward: "Previous balance recovery",
};
/** Columns of the consolidated sheet, in the union's order. */
export const SHEET_DEDUCTION_COLUMNS: { key: string; label: ReactNode; heads: string[] }[] = [
  { key: "crate", label: "Crate", heads: ["crate", "packet"] },
  { key: "dues", label: "Dues", heads: ["dues"] },
  { key: "km", label: <>KM<br />Ded.</>, heads: ["km"] },
  { key: "sd", label: <>Sec.<br />Dep</>, heads: ["security_deposit"] },
  { key: "gps", label: "GPS", heads: ["gps"] },
  { key: "tds", label: "TDS", heads: ["tds"] },
  { key: "others", label: "Others", heads: ["penalty", "advance", "carry_forward", "other_deduction"] },
];

export const PAY_MODES: { value: PayMode; label: string }[] = [
  { value: "neft", label: "NEFT" }, { value: "rtgs", label: "RTGS" }, { value: "imps", label: "IMPS" },
  { value: "upi", label: "UPI" }, { value: "cheque", label: "Cheque" }, { value: "cash", label: "Cash" },
];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** 'YYYY-MM' → 'Jul 2026' */
export const monthLabel = (m: string) => {
  const [y, mm] = (m ?? "").split("-").map(Number);
  return y && mm ? `${MONTHS[mm - 1]} ${y}` : m;
};
/** 'YYYY-MM' → 'July 2026' */
export const monthLong = (m: string) => {
  const [y, mm] = (m ?? "").split("-").map(Number);
  return y && mm ? `${MONTHS_LONG[mm - 1]} ${y}` : m;
};
export const fmtDMY = (iso?: string | null) => {
  if (!iso) return "";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return y && m && d ? `${d}-${m}-${y}` : iso;
};
export const fmtStamp = (ts?: string | null) =>
  ts ? new Date(ts).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
/** Whole rupees, Indian grouping, no symbol (sheet style). */
export const rs = (n: number | null | undefined) => fmtNum(Math.round(Number(n) || 0), 0);
/** Two decimals, no symbol. */
export const rs2 = (n: number | null | undefined) => fmtNum(Number(n) || 0, 2);
/** A number without trailing ".00": 300 → "300", 1.5 → "1.5", 12.79 → "12.79". */
export const nice = (n: number | null | undefined) => {
  const v = Number(n) || 0;
  return v.toLocaleString("en-IN", { maximumFractionDigits: 2 });
};
export const BASIS_LABEL: Record<BillingType, string> = { km: "Per km", trip: "Per trip", litre: "Per litre" };
export const qtyFmt = (n: number | null | undefined) => fmtNum(Math.round(Number(n) || 0), 0);
/** 'YYYY-MM' of the month before `iso`'s month. */
export function prevMonth(iso: string): string {
  const [y = 0, m = 1] = iso.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}
export function addMonths(month: string, n: number): string {
  const [y = 0, m = 1] = month.split("-").map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
}

export function RunStatusBadge({ status, className }: { status: RunStatus; className?: string }) {
  const tone = {
    draft: "bg-muted text-muted-foreground",
    submitted: "bg-warning/15 text-warning",
    pre_audited: "bg-warning/15 text-warning",
    mktg_approved: "bg-info/15 text-info",
    approved: "bg-success/15 text-success",
  }[status];
  return (
    <span className={cn("inline-block rounded px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap", tone, className)}>
      {RUN_STATUS_LABEL[status]}
    </span>
  );
}

/** Native month picker styled like the other inputs. */
export function MonthInput({ value, onChange, max, className }: {
  value: string; onChange: (v: string) => void; max?: string; className?: string;
}) {
  return (
    <input
      type="month"
      value={value}
      max={max}
      onChange={e => e.target.value && onChange(e.target.value)}
      className={cn("erp-input h-8 px-2 rounded border border-input bg-background text-[13px]", className)}
    />
  );
}

export function FilterLabel({ children }: { children: ReactNode }) {
  return <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">{children}</label>;
}

/** Simple 2-column info row used in dialogs and the bill header. */
export function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-3 py-0.5 text-[12.5px]">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{children}</span>
    </div>
  );
}

export const errMsg = (e: unknown) => (e as { message?: string })?.message ?? "Something went wrong";
