import React, { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate, Outlet } from "react-router-dom";
import {
  LayoutDashboard, Database, ShoppingCart, Truck, Boxes,
  BookOpenCheck, FileBarChart2, ShieldCheck, Search, Bell,
  ChevronDown, LogOut, Keyboard, Wallet,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { NavLink } from "react-router-dom";
import { AppSidebar } from "@/components/AppSidebar";
import { useKeyboardNav } from "@/lib/useKeyboardNav";

// ─── Module taxonomy (10-module spec, but we expose only the modules
//     that exist in the current web.txt routes — Masters, Sales, Stock,
//     Reports, Sales Reports, Finance, System) ─────────────────────────

export type ModuleKey =
  | "dashboard" | "masters" | "sales" | "fgs" | "finance"
  | "reports" | "sales-reports" | "system";

export const MODULES: { key: ModuleKey; label: string; icon: React.ComponentType<any>; path: string }[] = [
  { key: "dashboard",      label: "Dashboard",      icon: LayoutDashboard, path: "/" },
  { key: "masters",        label: "Masters",        icon: Database,        path: "/masters/customers" },
  { key: "sales",          label: "Sales",          icon: ShoppingCart,    path: "/sales/record-indents" },
  { key: "fgs",            label: "Stock & Dispatch", icon: Truck,         path: "/fgs/dashboard" },
  { key: "finance",        label: "Finance",        icon: Wallet,          path: "/finance/payments" },
  { key: "reports",        label: "Route Sheets",        icon: FileBarChart2,   path: "/reports/route-sheet" },
  { key: "sales-reports",  label: "Sales Reports", icon: FileBarChart2,   path: "/sales-reports/daily-statement" },
  { key: "system",         label: "Admin",          icon: ShieldCheck,     path: "/system/users" },
];

// Map a pathname to the active module key
export function moduleOfPath(pathname: string): ModuleKey {
  if (pathname === "/") return "dashboard";
  const seg = pathname.split("/")[1];
  switch (seg) {
    case "masters": return "masters";
    case "sales": return "sales";
    case "fgs": return "fgs";
    case "finance": return "finance";
    case "reports": return "reports";
    case "sales-reports": return "sales-reports";
    case "system": return "system";
    default: return "dashboard";
  }
}

// Build the breadcrumb [moduleLabel, subLabel?] from the URL
function useBreadcrumb(): string[] {
  const { pathname } = useLocation();
  const mod = MODULES.find(m => m.key === moduleOfPath(pathname));
  if (!mod) return ["Home"];
  const seg2 = pathname.split("/")[2];
  const seg3 = pathname.split("/")[3];
  const sub = seg3 ? `${labelize(seg2)} • ${labelize(seg3)}` : labelize(seg2);
  return sub ? [mod.label, sub] : [mod.label];
}
function labelize(seg?: string) {
  if (!seg) return "";
  return seg
    .replace(/-/g, " ")
    .replace(/\b\w/g, c => c.toUpperCase());
}

// ─── Command palette (inline shadcn dialog, no new files) ────────────

function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const [q, setQ] = useState("");

  useEffect(() => { if (!open) setQ(""); }, [open]);

  if (!open) return null;
  const items = COMMAND_ITEMS.filter(i =>
    !q || i.label.toLowerCase().includes(q.toLowerCase()) || i.path.toLowerCase().includes(q.toLowerCase())
  );

  return (
    <div
      data-kbd-modal
      className="fixed inset-0 z-[100] bg-black/50 flex items-start justify-center pt-32"
      onClick={onClose}
    >
      <div className="erp-panel w-[560px] max-w-[90vw]" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-border px-3 h-10">
          <Search className="w-3.5 h-3.5 text-muted-foreground" />
          <input
            autoFocus value={q} onChange={e => setQ(e.target.value)}
            placeholder="Search pages, customers, products…"
            className="flex-1 bg-transparent outline-none text-[13px]"
          />
          <span className="kbd">Esc</span>
        </div>
        <div className="max-h-80 overflow-auto py-1">
          {items.length === 0 && (
            <div className="text-center text-[12px] text-muted-foreground py-8">No matches.</div>
          )}
          {items.map(i => (
            <button
              key={i.path}
              onClick={() => { navigate(i.path); onClose(); }}
              className="w-full text-left px-3 py-1.5 text-[12.5px] hover:bg-accent flex items-center justify-between"
            >
              <span>{i.label}</span>
              <span className="text-[11px] text-muted-foreground font-mono">{i.path}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// Static index of jump targets (extend as needed; resolved against existing routes)
const COMMAND_ITEMS: { label: string; path: string }[] = [
  { label: "Dashboard", path: "/" },
  { label: "All Customers", path: "/masters/customers" },
  { label: "New Customer", path: "/masters/customers/new" },
  { label: "All Routes", path: "/masters/routes" },
  { label: "All Products", path: "/masters/products" },
  { label: "Price Chart", path: "/masters/price-chart" },
  { label: "Record Indents", path: "/sales/record-indents" },
  { label: "All Indents", path: "/sales/all-indents" },
  { label: "Invoices", path: "/sales/invoices" },
  { label: "Cancellation Requests", path: "/sales/cancellations" },
  { label: "Stock Overview", path: "/fgs/dashboard" },
  { label: "Stock Entry — Milk & Curd",     path: "/fgs/stock-entry/milk-curd" },
  { label: "Stock Entry — Other Products",  path: "/fgs/stock-entry/others"    },
  { label: "Dispatch Sheet", path: "/fgs/dispatch-sheet" },
  { label: "Create Dispatch", path: "/fgs/dispatch/create" },
  { label: "Payments", path: "/finance/payments" },
  { label: "Online Payments",  path: "/finance/online-payments" },
  { label: "Reconciliation",   path: "/finance/reconciliation"  },
  { label: "Route Sheet", path: "/reports/route-sheet" },
  { label: "Gate Pass Report", path: "/reports/gate-pass" },
  { label: "Daily Sales Statement", path: "/sales-reports/daily-statement" },
  { label: "Employee Subsidy Report", path: "/sales-reports/employee-subsidy" },
  { label: "User Management", path: "/system/users" },
  { label: "Roles & Access", path: "/system/roles" },
  { label: "Banner Management", path: "/system/banners" },
];

// ─── ErpShell ─────────────────────────────────────────────────────────

interface AppLayoutProps { children?: React.ReactNode; }

const AppLayout: React.FC<AppLayoutProps> = ({ children }) => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [userMenu, setUserMenu] = useState(false);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  useKeyboardNav();

  const activeModule = useMemo(() => moduleOfPath(pathname), [pathname]);
  const breadcrumb = useBreadcrumb();

  // --- Clean View Patch Start ---
  const __location = useLocation();
  const __isCleanView = new URLSearchParams(__location.search).get("clean") === "1";

  if (__isCleanView) {
    return (
      <div className="erp-clean-shell h-screen w-screen bg-background overflow-hidden flex flex-col">
        <div className="erp-clean-bar h-9 px-3 flex items-center text-[12px] text-muted-foreground border-b border-border bg-panel no-print">
          <span className="font-medium">Haveri Milk Union ERP — Clean View</span>
          <span className="mx-2">·</span>
          <span>Ctrl+P to print · ← / → to navigate</span>
          <button
            className="ml-auto h-7 px-2 text-[11.5px] border border-border rounded-sm hover:bg-accent"
            onClick={() => window.close()}
          >
            Close
          </button>
        </div>
        <div className="flex-1 overflow-auto">
          {children || <Outlet />}
        </div>
      </div>
    );
  }
  // --- Clean View Patch End ---

  // Ctrl+K command palette + Esc close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdOpen(true);
      } else if (e.key === "Escape") {
        setCmdOpen(false);
        setUserMenu(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const handleLogout = async () => {
    await logout();
    toast.success("Logged out");
  };

  // Username/role/avatar fallback when auth provides only minimal user
  const displayName = user?.name ?? "Admin";
  const role = user?.role ? user.role.replace(/_/g, " ") : "admin";
  const initials = displayName.split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase() || "A";

  return (
    <div className="flex flex-col h-screen bg-background">
      {/* TOP BAR */}
      <header className="erp-topbar bg-topbar text-topbar-foreground flex items-center h-12 px-3 gap-3 shadow-md no-print shrink-0">
        <div className="flex items-center gap-2 pr-3 border-r border-white/10">
          <div className="w-7 h-7 rounded-sm bg-white text-topbar grid place-items-center font-bold text-sm">H</div>
          <div className="leading-tight">
            <div className="text-[13px] font-semibold">Haveri Milk Union</div>
            <div className="text-[10px] opacity-70 -mt-0.5">v1.0 • Marketing</div>
          </div>
        </div>

        {/* Module tabs */}
        <nav
          data-kbd-region="topbar"
          className="flex items-center gap-0.5 overflow-x-auto flex-1 min-w-0"
        >
          {MODULES.map(m => {
            const Icon = m.icon;
            const active = activeModule === m.key;
            return (
              <NavLink
                key={m.key}
                to={m.path}
                className={cn(
                  "flex items-center gap-1.5 px-3 h-9 text-[12.5px] font-medium rounded-sm whitespace-nowrap transition-colors",
                  active ? "bg-topbar-accent text-white" : "text-white/80 hover:bg-white/10"
                )}
              >
                <Icon className="w-3.5 h-3.5" />
                {m.label}
              </NavLink>
            );
          })}
        </nav>

        {/* Search trigger (Ctrl+K) */}
        <button
          onClick={() => setCmdOpen(true)}
          className="hidden lg:flex items-center gap-2 bg-white/10 hover:bg-white/15 rounded-sm px-2.5 h-8 text-[12px] text-white/80 min-w-[200px]"
        >
          <Search className="w-3.5 h-3.5" />
          <span className="flex-1 text-left">Search dealers, products…</span>
          <span className="kbd !text-white/70 !border-white/20 !bg-white/10">Ctrl+K</span>
        </button>

        <button className="relative p-1.5 hover:bg-white/10 rounded-sm" title="Notifications">
          <Bell className="w-4 h-4" />
          <span className="absolute top-1 right-1 w-1.5 h-1.5 bg-warning rounded-full" />
        </button>

        {/* User menu */}
        <div className="relative">
          <button
            onClick={() => setUserMenu(v => !v)}
            className="flex items-center gap-2 hover:bg-white/10 rounded-sm px-2 h-8"
          >
            <div className="w-6 h-6 rounded-full bg-white/20 grid place-items-center text-[11px] font-semibold">
              {initials}
            </div>
            <div className="text-left leading-tight hidden sm:block">
              <div className="text-[12px] font-medium">{displayName}</div>
              <div className="text-[10px] opacity-70 capitalize">{role}</div>
            </div>
            <ChevronDown className="w-3 h-3 opacity-70" />
          </button>
          {userMenu && (
            <div className="absolute right-0 top-full mt-1 w-48 bg-panel text-foreground border border-border shadow-lg rounded-sm z-50">
              <button
                onClick={() => { setUserMenu(false); navigate("/system/users"); }}
                className="w-full text-left px-3 py-2 text-[12px] hover:bg-accent">
                My Profile
              </button>
              <button
                onClick={() => { setUserMenu(false); navigate("/system/users"); }}
                className="w-full text-left px-3 py-2 text-[12px] hover:bg-accent">
                Settings
              </button>
              <div className="border-t border-border" />
              <button
                onClick={() => { setUserMenu(false); handleLogout(); }}
                className="w-full text-left px-3 py-2 text-[12px] hover:bg-accent flex items-center gap-2 text-destructive">
                <LogOut className="w-3.5 h-3.5" /> Log out
              </button>
            </div>
          )}
        </div>
      </header>

      {/* BODY */}
      <div className="flex flex-1 min-h-0">
        {/* Contextual sidebar — hidden on Dashboard (no submenu) */}
        {activeModule !== "dashboard" && (
          <AppSidebar
            module={activeModule}
            collapsed={sidebarCollapsed}
            onToggle={() => setSidebarCollapsed(c => !c)}
          />
        )}

        {/* MAIN */}
        <main className="erp-main flex-1 min-w-0 flex flex-col">
          {/* Breadcrumb */}
          <div className="erp-breadcrumb px-4 py-2 border-b border-border bg-panel flex items-center text-[13px] text-muted-foreground gap-1.5 no-print shrink-0">
            {breadcrumb.map((b, i) => (
              <span key={i} className="flex items-center gap-1.5">
                {i > 0 && <span className="opacity-50">›</span>}
                <span className={i === breadcrumb.length - 1 ? "text-foreground font-medium" : ""}>{b}</span>
              </span>
            ))}
          </div>

          {/* Print-only letterhead — appears on every page when printed */}
          <div className="print-only print-header">
            <div className="company">HAVERI DISTRICT CO-OPERATIVE MILK PRODUCERS' UNION LTD.</div>
            <div className="sub">Haveri, Karnataka, India · GSTIN: 29XXXXXXXX1Z5 · Phone: +91-8375-XXXXXX</div>
            <div className="report-title">{breadcrumb[breadcrumb.length - 1] ?? "Report"}</div>
            <div className="meta">
              <span>Module: {breadcrumb[0]}</span>
              <span>Printed: {new Date().toLocaleString("en-IN")}</span>
            </div>
          </div>

          {/* PAGE CONTENT */}
          <div data-kbd-region="content" className="flex-1 overflow-auto">
            {children || <Outlet />}
          </div>

          {/* Print-only footer */}
          <div className="print-only print-footer">
            <span>Generated by {displayName} ({role})</span>
            <span>Haveri Milk Union ERP · Confidential</span>
          </div>

          {/* Status bar */}
          <div className="erp-statusbar h-6 bg-topbar text-white/80 text-[11.5px] flex items-center px-3 gap-4 border-t border-white/10 no-print shrink-0">
            <span className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-success" /> Online
            </span>
            <span>{displayName}</span>
            <span className="capitalize">{role}</span>
            <span>{new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}</span>
            <div className="flex-1" />
            <span className="flex items-center gap-1.5">
              <Keyboard className="w-3 h-3" />
              Tab Switch area • ↑↓ Move • Enter Open/Next field • Ctrl+S Save • Ctrl+K Find
            </span>
          </div>
        </main>
      </div>

      <CommandPalette open={cmdOpen} onClose={() => setCmdOpen(false)} />
    </div>
  );
};

export default AppLayout;