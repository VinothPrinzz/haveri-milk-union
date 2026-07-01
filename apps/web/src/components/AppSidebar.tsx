import { NavLink, useLocation } from "react-router-dom";
import {
  Users, UserPlus, MapPin, Map, ClipboardList, Package, PackagePlus, Tags,
  TrendingUp, History, FileText, ClipboardCheck, ScrollText, CreditCard,
  Receipt, Warehouse, BarChart3, FileSpreadsheet, Plus, Truck,
  Wallet, Bell, Image as ImageIcon, Shield, UserCog, Timer, ChevronLeft,
  ChevronRight, FileBarChart2, BookOpen, Map as RouteIcon, Database,
  Star, Briefcase, Gift, BadgePercent, CalendarClock, GitCompareArrows,
  ShieldAlert, Banknote, RotateCcw, FilePlus2, BadgeIndianRupee, X, Factory
} from "lucide-react";
import { cn } from "@/lib/utils";
import { MODULES, moduleOfPath, type ModuleKey } from "@/components/AppLayout";
import { useAuth } from "@/lib/auth";
import { allowedBucketsForRole } from "@/lib/stock-buckets";

// Sidebar links gated to a specific stock bucket. A bucket-scoped FGS operator
// only sees the Stock Entry / Dispatch Sheet links for their own SK diary.
const BUCKET_PATHS: Record<string, "milk-curd" | "others"> = {
  "/fgs/stock-entry/milk-curd":    "milk-curd",
  "/fgs/stock-entry/others":       "others",
  "/fgs/dispatch-sheet/milk-curd": "milk-curd",
  "/fgs/dispatch-sheet/others":    "others",
};

interface NavItem { label: string; path: string; icon: React.ComponentType<{ className?: string }>; }

const SIDEBAR_NAV: Record<ModuleKey, NavItem[]> = {
  dashboard: [],
  masters: [
    { label: "All Customers",    path: "/masters/customers",         icon: Users },
    { label: "New Customer",     path: "/masters/customers/new",     icon: UserPlus },
    { label: "Assign Route",     path: "/masters/customers/assign-route", icon: MapPin },
    { label: "All Contractors",  path: "/masters/contractors",       icon: Truck },
    { label: "New Contractor",   path: "/masters/contractors/new",   icon: UserPlus },
    { label: "All Suppliers",    path: "/masters/suppliers",         icon: Factory },
    { label: "New Supplier",     path: "/masters/suppliers/new",     icon: UserPlus },
    { label: "All Routes",       path: "/masters/routes",            icon: Map },
    { label: "New Route",        path: "/masters/routes/new",        icon: MapPin },
    { label: "All Batches",      path: "/masters/batches",           icon: ClipboardList },
    { label: "New Batch",        path: "/masters/batches/new",       icon: ClipboardList },
    { label: "All Products",     path: "/masters/products",          icon: Package },
    { label: "Add Product",      path: "/masters/products/add",      icon: PackagePlus },
    { label: "Price Chart",      path: "/masters/price-chart",       icon: TrendingUp },
    { label: "Price Revisions",  path: "/masters/price-revisions",   icon: History },
    { label: "VIP Contacts",     path: "/masters/vip-contacts",      icon: Star      /* or Users */ },
    { label: "Employees",        path: "/masters/employees",         icon: Briefcase /* or IdCard */ },
    { label: "All Officers",     path: "/masters/officers",          icon: UserCog },
    { label: "New Officer",      path: "/masters/officers/new",      icon: UserPlus },
  ],
  sales: [
    { label: "Record Indents",   path: "/sales/record-indents",                  icon: FileText },
    { label: "Subsidy Indents",  path: "/sales/subsidy-indents",                 icon: BadgeIndianRupee },
    { label: "Dealer Indents", path: "/sales/dealer-indents", icon: CalendarClock },
    { label: "All Indents",      path: "/sales/all-indents",                     icon: ClipboardCheck },
    { label: "Direct - Gate Pass", path: "/sales/direct-sales/gate-pass",        icon: ScrollText },
    { label: "Direct - Cash",    path: "/sales/direct-sales/cash-customer",      icon: CreditCard },
    { label: "Direct - VIP Sample",     path: "/sales/direct-sales/vip-sample",        icon: Gift },
    { label: "Direct - Employee",       path: "/sales/direct-sales/employee-subsidy",  icon: BadgePercent },
    { label: "Indent Modify",    path: "/sales/direct-sales/modify",         icon: ClipboardList },
    { label: "Recent Sales",     path: "/sales/direct-sales/recent",             icon: Receipt },
    { label: "All Invoices",     path: "/sales/invoices",                        icon: Receipt },
  ],
  fgs: [
    { label: "Stock Overview",   path: "/fgs/dashboard",            icon: BarChart3 },
    { label: "Stock Entry - Milk & Curd",     path: "/fgs/stock-entry/milk-curd", icon: Warehouse },
    { label: "Stock Entry - Other Products", path: "/fgs/stock-entry/others",    icon: Warehouse },
    { label: "Stock Reports",    path: "/fgs/reports",              icon: FileSpreadsheet },
    { label: "Dispatch Sheet - Milk & Curd",     path: "/fgs/dispatch-sheet/milk-curd", icon: ClipboardList },
    { label: "Dispatch Sheet - Other Products", path: "/fgs/dispatch-sheet/others",    icon: ClipboardList },
    { label: "Create Dispatch",  path: "/fgs/dispatch/create",      icon: Plus },
  ],
  finance: [
    { label: "Finance Dashboard", path: "/finance/dashboard",       icon: BarChart3 },
    { label: "Payments Overview", path: "/finance/payments",        icon: Wallet },
    { label: "Online Payments",   path: "/finance/online-payments", icon: CreditCard },
    { label: "Reconciliation",    path: "/finance/reconciliation",  icon: GitCompareArrows },
    { label: "Available Balances", path: "/finance/credit-control",  icon: Wallet },
    { label: "Employee Credit",   path: "/finance/employee-credit-limits", icon: BadgeIndianRupee },
    { label: "AR Aging",          path: "/finance/ar-aging",        icon: FileBarChart2 },
    { label: "Dealer Statements", path: "/finance/dealer-statements", icon: ScrollText },
    { label: "Cheques",           path: "/finance/cheques",         icon: Banknote },
    { label: "Refunds",           path: "/finance/refunds",         icon: RotateCcw },
    { label: "Credit/Debit Notes", path: "/finance/adjustments",    icon: FilePlus2 },
    { label: "Day Book",          path: "/finance/day-book",        icon: BookOpen },
  ],
  reports: [
    { label: "Route Sheet",      path: "/reports/route-sheet",      icon: RouteIcon },
    { label: "Gate Pass Report", path: "/reports/gate-pass",        icon: FileText },
  ],
  "sales-reports": [
    { label: "Daily Sales Report",        path: "/sales-reports/daily-sales-report", icon: FileSpreadsheet },
    { label: "Monthly Sales Report",      path: "/sales-reports/monthly-sales-report", icon: FileSpreadsheet },
    { label: "Daily Sales Statement",     path: "/sales-reports/daily-statement", icon: FileSpreadsheet },
    { label: "Day/Route Wise Cash",       path: "/sales-reports/day-route-cash",  icon: FileSpreadsheet },
    { label: "Officer Wise Sales",        path: "/sales-reports/officer-wise",    icon: FileSpreadsheet },
    { label: "Cash Sales",                path: "/sales-reports/cash-sales",      icon: FileSpreadsheet },
    { label: "Credit Sales",              path: "/sales-reports/credit-sales",    icon: FileSpreadsheet },
    { label: "Sales Register",            path: "/sales-reports/register",        icon: BookOpen },
    { label: "Taluka/Agent Wise",         path: "/sales-reports/taluka-agent",    icon: FileSpreadsheet },
    { label: "Taluka Wise Report",        path: "/sales-reports/taluka-wise",     icon: FileSpreadsheet },
    { label: "Adhoc Sales",               path: "/sales-reports/adhoc",           icon: FileSpreadsheet },
    { label: "GST Statement",             path: "/sales-reports/gst",             icon: FileBarChart2 },
    { label: "Employee Subsidy",          path: "/sales-reports/employee-subsidy", icon: BadgePercent },
    { label: "VIP Sales",                 path: "/sales-reports/vip-sales",        icon: Gift },
  ],
  system: [
    { label: "User Management",        path: "/system/users",                icon: UserCog },
    { label: "Roles & Access",         path: "/system/roles",                icon: Shield },
    { label: "Time Windows",           path: "/system/time-windows",         icon: Timer },
    { label: "Notifications",          path: "/system/notifications",        icon: Bell },
    { label: "Dealer Notifications",   path: "/system/dealer-notifications", icon: Bell },
    { label: "Banner Management",      path: "/system/banners",              icon: ImageIcon },
    { label: "Database Health",        path: "/system/db-health",            icon: Database },
  ],
};

const MODULE_LABEL: Record<ModuleKey, string> = {
  dashboard: "Dashboard",
  masters: "Masters",
  sales: "Sales Operations",
  fgs: "FGS — Stock & Dispatch",
  finance: "Finance",
  reports: "Route Sheets",
  "sales-reports": "Sales Reports",
  system: "Admin",
};

export function AppSidebar({
  module, collapsed, onToggle, mobileOpen = false, onMobileClose,
}: {
  module: ModuleKey;
  collapsed: boolean;
  onToggle: () => void;
  mobileOpen?: boolean;
  onMobileClose?: () => void;
}) {
  const { pathname } = useLocation();
  const { user } = useAuth();
  const allowedBuckets = allowedBucketsForRole(user?.role);
  const activeModule = moduleOfPath(pathname);

  // Hide the Stock Entry link for a bucket the current user can't access.
  const items = (SIDEBAR_NAV[module] ?? []).filter(item => {
    const bucket = BUCKET_PATHS[item.path];
    return !bucket || allowedBuckets.includes(bucket);
  });

  const navItemClass = (active: boolean) =>
    cn(
      "flex items-center gap-2 px-3 py-1.5 text-[12.5px] border-l-2 transition-colors",
      active
        ? "bg-sidebar-accent text-sidebar-accent-foreground border-sidebar-primary font-medium"
        : "border-transparent text-sidebar-foreground hover:bg-sidebar-accent/60"
    );

  return (
    <>
      {/* Mobile drawer backdrop */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden no-print"
          onClick={onMobileClose}
          aria-hidden
        />
      )}

      <aside
        className={cn(
          "erp-sidebar bg-sidebar border-r border-sidebar-border flex flex-col transition-all no-print shrink-0",
          // Mobile: off-canvas drawer (full-width labels), slides in over content
          "fixed inset-y-0 left-0 z-50 w-64 lg:static lg:z-auto lg:translate-x-0",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
          // Desktop: in-flow column with collapse support
          collapsed ? "lg:w-12" : "lg:w-56",
          // Desktop only: no submenu (e.g. Dashboard) → no sidebar column
          items.length === 0 && "lg:hidden"
        )}
      >
        <div className="px-3 py-2 border-b border-sidebar-border flex items-center justify-between h-9">
          {/* Desktop: current module label */}
          <span
            className={cn(
              "text-[11px] font-semibold uppercase tracking-wider text-sidebar-foreground/70 truncate",
              collapsed ? "hidden" : "hidden lg:block"
            )}
          >
            {MODULE_LABEL[module]}
          </span>
          {/* Mobile: drawer title */}
          <span className="lg:hidden text-[11px] font-semibold uppercase tracking-wider text-sidebar-foreground/70">
            Menu
          </span>
          {/* Desktop collapse/expand toggle */}
          <button
            onClick={onToggle}
            className="hidden lg:block p-1 hover:bg-sidebar-accent rounded-sm text-sidebar-foreground"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronLeft className="w-3.5 h-3.5" />}
          </button>
          {/* Mobile close */}
          <button
            onClick={onMobileClose}
            className="lg:hidden p-1 hover:bg-sidebar-accent rounded-sm text-sidebar-foreground"
            aria-label="Close menu"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <nav data-kbd-region="sidebar" className="flex-1 overflow-y-auto py-1">
          {/* Mobile only: main module switcher (the former top navigation) */}
          <div className="lg:hidden">
            {MODULES.map(m => {
              const Icon = m.icon;
              const active = activeModule === m.key;
              return (
                <NavLink
                  key={m.key}
                  to={m.path}
                  title={m.label}
                  onClick={onMobileClose}
                  className={navItemClass(active)}
                >
                  <Icon className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate">{m.label}</span>
                </NavLink>
              );
            })}
            {items.length > 0 && (
              <div className="mt-2 px-3 pt-2 pb-1 border-t border-sidebar-border text-[10px] font-semibold uppercase tracking-wider text-sidebar-foreground/50">
                {MODULE_LABEL[module]}
              </div>
            )}
          </div>

          {/* Active module's sub-pages */}
          {items.map(item => {
            const Icon = item.icon;
            const active =
              pathname === item.path ||
              (item.path !== "/" && pathname.startsWith(item.path + "/"));
            return (
              <NavLink
                key={item.path}
                to={item.path}
                title={item.label}
                onClick={onMobileClose}
                className={navItemClass(active)}
              >
                <Icon className="w-3.5 h-3.5 shrink-0" />
                <span className={cn("truncate", collapsed && "lg:hidden")}>{item.label}</span>
              </NavLink>
            );
          })}
        </nav>
      </aside>
    </>
  );
}