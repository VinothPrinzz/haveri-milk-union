"use client";
import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export function Modal({
  open,
  onClose,
  title,
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  className?: string;
}) {
  useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className={cn(
          "bg-card rounded-xl border border-border shadow-lg w-full max-h-[85vh] overflow-y-auto",
          className ?? "max-w-md"
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-border sticky top-0 bg-card z-10 rounded-t-xl">
          <h3 className="font-display text-sm font-bold text-fg">{title}</h3>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md border border-border hover:bg-muted transition-colors"
          >
            <X className="h-4 w-4 text-muted-fg" />
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

export function FormField({
  label,
  children,
  required,
}: {
  label: string;
  children: ReactNode;
  required?: boolean;
}) {
  return (
    <div>
      <label className="block text-[11px] font-semibold text-fg mb-1.5">
        {label}
        {required && <span className="text-danger ml-0.5">*</span>}
      </label>
      {children}
    </div>
  );
}

export function FormInput({
  className,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { className?: string }) {
  return (
    <input
      className={cn(
        "w-full bg-background border border-border rounded-lg px-3 py-2 text-[12px] font-medium text-fg outline-none focus:border-brand focus:ring-1 focus:ring-brand/20 transition-colors",
        className
      )}
      {...props}
    />
  );
}

export function FormSelect({
  children,
  className,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement> & { className?: string }) {
  return (
    <select
      className={cn(
        "w-full bg-background border border-border rounded-lg px-3 py-2 text-[12px] font-medium text-fg outline-none focus:border-brand transition-colors",
        className
      )}
      {...props}
    >
      {children}
    </select>
  );
}
