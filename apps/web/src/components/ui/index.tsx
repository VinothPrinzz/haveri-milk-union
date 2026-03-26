"use client";
import type { ReactNode } from "react";
import { cn, statusColor } from "@/lib/utils";

// ── Page Header (matches design: icon + title + subtitle + action buttons) ──
export function PageHeader({
  icon,
  title,
  subtitle,
  actions,
}: {
  icon?: string;
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between mb-6">
      <div>
        <h1 className="font-display text-xl font-bold text-fg flex items-center gap-2">
          {icon && <span>{icon}</span>}
          {title}
        </h1>
        {subtitle && (
          <p className="text-[11px] text-muted-fg font-medium mt-0.5">
            {subtitle}
          </p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

// ── Stat Card (matches design: icon square + value + label + delta) ──
export function StatCard({
  icon,
  iconBg = "bg-brand-light text-brand",
  value,
  label,
  delta,
  deltaUp,
}: {
  icon: string;
  iconBg?: string;
  value: string | number;
  label: string;
  delta?: string;
  deltaUp?: boolean;
}) {
  return (
    <div className="bg-card rounded-[10px] border border-border shadow-card p-4">
      <div
        className={cn(
          "w-9 h-9 rounded-lg flex items-center justify-center text-[15px] mb-2.5",
          iconBg
        )}
      >
        {icon}
      </div>
      <div className="font-display text-[22px] font-black text-fg">{value}</div>
      <div className="text-[11px] font-semibold text-muted-fg mt-0.5">
        {label}
      </div>
      {delta && (
        <div
          className={cn(
            "text-[11px] font-semibold mt-1",
            deltaUp ? "text-success" : "text-danger"
          )}
        >
          {deltaUp ? "↑" : "↓"} {delta}
        </div>
      )}
    </div>
  );
}

// ── Badge ──
export function Badge({
  children,
  variant = "muted",
  className,
}: {
  children: ReactNode;
  variant?: string;
  className?: string;
}) {
  // If variant is a status string like "pending", "active", etc.
  const badgeClass = variant.startsWith("badge-")
    ? variant
    : statusColor(variant);

  return (
    <span className={cn("badge", badgeClass, className)}>{children}</span>
  );
}

// ── Button ──
export function Button({
  children,
  variant = "primary",
  size = "default",
  className,
  ...props
}: {
  children: ReactNode;
  variant?: "primary" | "outline" | "ghost" | "danger";
  size?: "default" | "sm";
  className?: string;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-lg font-semibold transition-colors",
        size === "sm" ? "px-3 py-1.5 text-[11px]" : "px-4 py-2 text-[12px]",
        variant === "primary" && "bg-brand text-white hover:bg-brand/90",
        variant === "outline" &&
          "bg-card border border-border text-fg hover:bg-muted",
        variant === "ghost" && "text-muted-fg hover:bg-muted hover:text-fg",
        variant === "danger" && "bg-danger text-white hover:bg-danger/90",
        className
      )}
      {...props}
    >
      {children}
    </button>
  );
}

// ── Card ──
export function Card({
  children,
  className,
  title,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <div
      className={cn(
        "bg-card rounded-[10px] border border-border shadow-card",
        className
      )}
    >
      {title && (
        <div className="px-4 py-3 border-b border-border">
          <h2 className="font-display text-xs font-bold text-fg flex items-center gap-1.5">
            {title}
          </h2>
        </div>
      )}
      {children}
    </div>
  );
}

// ── Table Card wrapper ──
export function TableCard({
  children,
  header,
}: {
  children: ReactNode;
  header?: ReactNode;
}) {
  return (
    <div className="bg-card rounded-[10px] border border-border shadow-card overflow-hidden">
      {header && (
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          {header}
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">{children}</table>
      </div>
    </div>
  );
}

// ── Table head cell ──
export function Th({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <th
      className={cn(
        "text-left px-4 py-2.5 text-[10px] font-semibold text-muted-fg border-b border-border bg-[rgba(220,228,244,0.4)] whitespace-nowrap",
        className
      )}
    >
      {children}
    </th>
  );
}

// ── Table data cell ──
export function Td({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <td
      className={cn(
        "px-4 py-2.5 text-[11px] text-fg border-b border-border",
        className
      )}
    >
      {children}
    </td>
  );
}

// ── Empty State ──
export function EmptyState({ message }: { message: string }) {
  return (
    <div className="py-16 text-center">
      <div className="text-3xl mb-2">📭</div>
      <p className="text-sm text-muted-fg font-medium">{message}</p>
    </div>
  );
}

// ── Loading Skeleton ──
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn("animate-pulse bg-muted rounded", className)}
    />
  );
}
