import { clsx, type ClassValue } from "clsx";

export function cn(...inputs: ClassValue[]) {
  return clsx(inputs);
}

export function formatCurrency(amount: number | string): string {
  const num = typeof amount === "string" ? parseFloat(amount) : amount;
  return `₹${num.toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

export function formatDate(date: string | Date): string {
  const d = new Date(date);
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

export function formatTime(date: string | Date): string {
  const d = new Date(date);
  return d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });
}

export function statusColor(status: string): string {
  const map: Record<string, string> = {
    confirmed: "badge-success",
    delivered: "badge-brand",
    dispatched: "badge-info",
    pending: "badge-warning",
    cancelled: "badge-danger",
    failed: "badge-danger",
    paid: "badge-success",
    active: "badge-success",
    inactive: "badge-muted",
    approved: "badge-success",
    rejected: "badge-danger",
    loading: "badge-info",
  };
  return map[status] || "badge-muted";
}
