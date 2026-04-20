import * as React from "react";
import { cn } from "@/lib/utils";

interface SidebarContextValue {
  open: boolean;
  setOpen: (v: boolean) => void;
}
const SidebarContext = React.createContext<SidebarContextValue>({ open: true, setOpen: () => {} });

export function SidebarProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(true);
  return <SidebarContext.Provider value={{ open, setOpen }}><div className="flex min-h-screen w-full">{children}</div></SidebarContext.Provider>;
}
export function useSidebar() { return React.useContext(SidebarContext); }

export function Sidebar({ className, children }: { className?: string; children: React.ReactNode }) {
  const { open } = useSidebar();
  return (
    <aside className={cn("flex flex-col h-screen sticky top-0 bg-sidebar border-r border-sidebar-border transition-all duration-200 no-print", open ? "w-60" : "w-0 overflow-hidden", className)}>
      {children}
    </aside>
  );
}
export function SidebarHeader({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("px-4 py-3 border-b border-sidebar-border shrink-0", className)}>{children}</div>;
}
export function SidebarContent({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("flex-1 overflow-y-auto py-2", className)}>{children}</div>;
}
export function SidebarFooter({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("px-4 py-3 border-t border-sidebar-border shrink-0", className)}>{children}</div>;
}
export function SidebarGroup({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("px-2 mb-1", className)}>{children}</div>;
}
export function SidebarGroupLabel({ className, children }: { className?: string; children: React.ReactNode }) {
  return <p className={cn("px-2 py-1 text-[10px] uppercase tracking-widest font-semibold text-sidebar-foreground/40 mt-2", className)}>{children}</p>;
}
export function SidebarGroupContent({ children }: { children: React.ReactNode }) {
  return <div>{children}</div>;
}
export function SidebarMenu({ children }: { children: React.ReactNode }) {
  return <ul className="space-y-0.5">{children}</ul>;
}
export function SidebarMenuItem({ children }: { children: React.ReactNode }) {
  return <li>{children}</li>;
}
export function SidebarMenuButton({ className, isActive, asChild, children, ...props }: { className?: string; isActive?: boolean; asChild?: boolean; children: React.ReactNode; onClick?: () => void }) {
  const cls = cn("flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-sidebar-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground", isActive && "bg-sidebar-accent text-sidebar-accent-foreground font-medium", className);
  if (asChild && React.isValidElement(children)) {
    return React.cloneElement(children as React.ReactElement<{ className?: string }>, { className: cn((children as React.ReactElement<{ className?: string }>).props.className, cls) });
  }
  return <button className={cls} {...props}>{children}</button>;
}
export function SidebarTrigger({ className }: { className?: string }) {
  const { open, setOpen } = useSidebar();
  return (
    <button onClick={() => setOpen(!open)} className={cn("p-1.5 rounded hover:bg-accent transition-colors", className)}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
        <rect y="2" width="16" height="1.5" rx="1" />
        <rect y="7" width="16" height="1.5" rx="1" />
        <rect y="12" width="16" height="1.5" rx="1" />
      </svg>
    </button>
  );
}
