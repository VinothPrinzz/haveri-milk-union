import { NavLink, useLocation } from "react-router-dom";
import {
  Users, UserPlus, MapPin, Map, ClipboardList, Package, PackagePlus, Tags,
  TrendingUp, History, FileText, Send, ClipboardCheck, ScrollText, CreditCard,
  Receipt, XCircle, Warehouse, BarChart3, FileSpreadsheet, Plus, Truck,
  Wallet, Bell, Image as ImageIcon, Shield, UserCog, Timer, ChevronLeft,
  ChevronRight, FileBarChart2, BookOpen, Map as RouteIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { ModuleKey } from "@/components/AppLayout";

interface NavItem { label: string; path: string; icon: React.ComponentType<{ className?: string }>; }

const SIDEBAR_NAV: Record<ModuleKey, NavItem[]> = {
  dashboard: [],
  masters: [
    { label: "All Customers",    path: "/masters/customers",         icon: Users },
    { label: "New Customer",     path: "/masters/customers/new",     icon: UserPlus },
    { label: "Assign Route",     path: "/masters/customers/assign-route", icon: MapPin },
    { label: "All Contractors",  path: "/masters/contractors",       icon: Truck },
    { label: "New Contractor",   path: "/masters/contractors/new",   icon: UserPlus },
    { label: "All Routes",       path: "/masters/routes",            icon: Map },
    { label: "New Route",        path: "/masters/routes/new",        icon: MapPin },
    { label: "All Batches",      path: "/masters/batches",           icon: ClipboardList },
    { label: "New Batch",        path: "/masters/batches/new",       icon: ClipboardList },
    { label: "All Products",     path: "/masters/products",          icon: Package },
    { label: "Add Product",      path: "/masters/products/add",      icon: PackagePlus },
    { label: "Price Chart",      path: "/masters/price-chart",       icon: TrendingUp },
    { label: "Price Revisions",  path: "/masters/price-revisions",   icon: History },
  ],
  sales: [
    { label: "Record Indents",   path: "/sales/record-indents",                  icon: FileText },
    { label: "Post Indent",      path: "/sales/post-indent",                     icon: Send },
    { label: "All Indents",      path: "/sales/all-indents",                     icon: ClipboardCheck },
    { label: "Direct — Gate Pass", path: "/sales/direct-sales/gate-pass",        icon: ScrollText },
    { label: "Direct — Cash",    path: "/sales/direct-sales/cash-customer",      icon: CreditCard },
    { label: "Indent Modify",  path: "/sales/direct-sales/modify",             icon: ClipboardList },
    { label: "Recent Sales",     path: "/sales/direct-sales/recent",             icon: Receipt },
    { label: "All Invoices",     path: "/sales/invoices",                        icon: Receipt },
    { label: "Cancellations",    path: "/sales/cancellations",                   icon: XCircle },
  ],
  fgs: [
    { label: "Stock Overview",   path: "/fgs/dashboard",            icon: BarChart3 },
    { label: "Stock Entry",      path: "/fgs/stock-entry",          icon: Warehouse },
    { label: "Stock Reports",    path: "/fgs/reports",              icon: FileSpreadsheet },
    { label: "Dispatch Sheet",   path: "/fgs/dispatch-sheet",       icon: ClipboardList },
    { label: "Create Dispatch",  path: "/fgs/dispatch/create",      icon: Plus },
  ],
  finance: [
    { label: "Payments Overview", path: "/finance/payments",        icon: Wallet },
  ],
  reports: [
    { label: "Route Sheet",      path: "/reports/route-sheet",      icon: RouteIcon },
    { label: "Gate Pass Report", path: "/reports/gate-pass",        icon: FileText },
  ],
  "sales-reports": [
    { label: "Daily Sales Statement",     path: "/sales-reports/daily-statement", icon: FileSpreadsheet },
    { label: "Day/Route Wise Cash",       path: "/sales-reports/day-route-cash",  icon: FileSpreadsheet },
    { label: "Officer Wise Sales",        path: "/sales-reports/officer-wise",    icon: FileSpreadsheet },
    { label: "Cash Sales",                path: "/sales-reports/cash-sales",      icon: FileSpreadsheet },
    { label: "Credit Sales",              path: "/sales-reports/credit-sales",    icon: FileSpreadsheet },
    { label: "Sales Register",            path: "/sales-reports/register",        icon: BookOpen },
    { label: "Taluka/Agent Wise",         path: "/sales-reports/taluka-agent",    icon: FileSpreadsheet },
    { label: "Adhoc Sales",               path: "/sales-reports/adhoc",           icon: FileSpreadsheet },
    { label: "GST Statement",             path: "/sales-reports/gst",             icon: FileBarChart2 },
  ],
  system: [
    { label: "User Management",        path: "/system/users",                icon: UserCog },
    { label: "Roles & Access",         path: "/system/roles",                icon: Shield },
    { label: "Time Windows",           path: "/system/time-windows",         icon: Timer },
    { label: "Notifications",          path: "/system/notifications",        icon: Bell },
    { label: "Dealer Notifications",   path: "/system/dealer-notifications", icon: Bell },
    { label: "Banner Management",      path: "/system/banners",              icon: ImageIcon },
  ],
};

const MODULE_LABEL: Record<ModuleKey, string> = {
  dashboard: "Dashboard",
  masters: "Masters",
  sales: "Sales Operations",
  fgs: "FGS — Stock & Dispatch",
  finance: "Finance",
  reports: "Reports",
  "sales-reports": "Sales Reports",
  system: "Admin",
};

export function AppSidebar({
  module, collapsed, onToggle,
}: { module: ModuleKey; collapsed: boolean; onToggle: () => void }) {
  const items = SIDEBAR_NAV[module] ?? [];
  const { pathname } = useLocation();

  if (items.length === 0) return null;

  return (
    <aside
      className={cn(
        "erp-sidebar bg-sidebar border-r border-sidebar-border flex flex-col transition-all no-print shrink-0",
        collapsed ? "w-12" : "w-56"
      )}
    >
      <div className="px-3 py-2 border-b border-sidebar-border flex items-center justify-between h-9">
        {!collapsed && (
          <span className="text-[11px] font-semibold uppercase tracking-wider text-sidebar-foreground/70 truncate">
            {MODULE_LABEL[module]}
          </span>
        )}
        <button
          onClick={onToggle}
          className="p-1 hover:bg-sidebar-accent rounded-sm text-sidebar-foreground"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronLeft className="w-3.5 h-3.5" />}
        </button>
      </div>
      <nav className="flex-1 overflow-y-auto py-1">
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
              className={cn(
                "flex items-center gap-2 px-3 py-1.5 text-[12.5px] border-l-2 transition-colors",
                active
                  ? "bg-sidebar-accent text-sidebar-accent-foreground border-sidebar-primary font-medium"
                  : "border-transparent text-sidebar-foreground hover:bg-sidebar-accent/60"
              )}
            >
              <Icon className="w-3.5 h-3.5 shrink-0" />
              {!collapsed && <span className="truncate">{item.label}</span>}
            </NavLink>
          );
        })}
      </nav>
    </aside>
  );
}