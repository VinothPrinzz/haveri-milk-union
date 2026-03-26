"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/lib/auth-store";
import {
  LayoutDashboard, ShoppingCart, Plus, XCircle, Package, Tag, TrendingUp,
  Factory, RefreshCw, MapPin, GitBranch, FileText, Clock, Globe,
  Users, UserPlus, BookOpen, CreditCard, Receipt, DollarSign, Wallet, Landmark, AlertCircle,
  BarChart3, PieChart, Map, Activity, Bell, Shield, UserCog, Globe2, ChevronDown,
} from "lucide-react";
import { useState } from "react";

const NAV_GROUPS = [
  { label: "SALES & ORDERS", items: [
    { name: "All Indents", href: "/orders", icon: ShoppingCart },
    { name: "New Indent (Call Desk)", href: "/orders/new", icon: Plus },
    { name: "Cancellation Requests", href: "/orders/cancellations", icon: XCircle },
  ]},
  { label: "PRODUCTS", items: [
    { name: "Product List", href: "/products", icon: Package },
    { name: "Categories", href: "/products/categories", icon: Tag },
    { name: "Price Revision", href: "/products/price-revision", icon: TrendingUp },
  ]},
  { label: "FGS (STOCK)", items: [
    { name: "Stock Overview", href: "/inventory", icon: Factory },
    { name: "Stock Update", href: "/inventory/update", icon: RefreshCw },
  ]},
  { label: "ROUTES & DISPATCH", items: [
    { name: "Route Master", href: "/distribution/routes", icon: MapPin },
    { name: "Route Assignments", href: "/distribution/assignments", icon: GitBranch },
    { name: "Daily Dispatch Sheet", href: "/distribution/dispatch", icon: FileText },
  ]},
  { label: "DEALERS / AGENCIES", items: [
    { name: "All Dealers", href: "/dealers", icon: Users },
    { name: "Registrations", href: "/dealers/registrations", icon: UserPlus },
    { name: "Dealer Ledger", href: "/dealers/ledger", icon: BookOpen },
  ]},
  { label: "PAYMENTS & BANK", items: [
    { name: "Payment Overview", href: "/finance/payments", icon: DollarSign },
    { name: "Settlements", href: "/finance/settlements", icon: Landmark },
    { name: "Outstanding / Dues", href: "/finance/outstanding", icon: AlertCircle },
    { name: "Wallet / Ledger", href: "/finance/wallet", icon: Wallet },
  ]},
  { label: "INVOICES & TAX", items: [
    { name: "All Invoices", href: "/finance/invoices", icon: Receipt },
    { name: "GST Reports", href: "/finance/gst", icon: CreditCard },
  ]},
  { label: "REPORTS", items: [
    { name: "Sales Report", href: "/reports/sales", icon: BarChart3 },
    { name: "Route & Dispatch", href: "/reports/dispatch", icon: Map },
    { name: "Dealer-wise Report", href: "/reports/dealers", icon: PieChart },
    { name: "FGS Movement", href: "/reports/fgs", icon: Activity },
    { name: "Zone-wise Revenue", href: "/reports/zones", icon: Globe },
  ]},
  { label: "SYSTEM", items: [
    { name: "Time Windows", href: "/system/time-windows", icon: Clock },
    { name: "Notifications", href: "/system/notifications", icon: Bell },
    { name: "Roles & Access", href: "/system/roles", icon: Shield },
    { name: "User Management", href: "/system/users", icon: UserCog },
    { name: "Zone Config", href: "/system/zones", icon: Globe2 },
  ]},
];

function SidebarGroup({ label, items, pathname }: { label: string; items: typeof NAV_GROUPS[0]["items"]; pathname: string }) {
  const isActive = items.some((i) => pathname.startsWith(i.href));
  const [open, setOpen] = useState(isActive);
  return (
    <div className="mb-0.5">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center justify-between px-3 py-1.5 text-[10px] font-semibold text-muted-fg uppercase tracking-wider hover:text-fg transition-colors">
        {label}<ChevronDown className={cn("h-3 w-3 transition-transform", open && "rotate-180")} />
      </button>
      {open && <div className="space-y-0.5">{items.map((item) => {
        const active = pathname === item.href || pathname.startsWith(item.href + "/");
        return (<Link key={item.href} href={item.href} className={cn("flex items-center gap-2.5 px-3 py-[7px] mx-1.5 rounded-lg text-[11px] font-semibold transition-colors", active ? "bg-brand-light text-brand" : "text-muted-fg hover:bg-muted hover:text-fg")}><item.icon className="h-[14px] w-[14px] shrink-0" />{item.name}</Link>);
      })}</div>}
    </div>
  );
}

export function Sidebar() {
  const pathname = usePathname();
  const user = useAuthStore((s) => s.user);
  return (
    <aside className="w-[230px] bg-[#FAFAFA] border-r border-border flex flex-col shrink-0 h-screen sticky top-0 overflow-y-auto">
      <div className="px-4 py-3.5 border-b border-border">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-brand flex items-center justify-center text-white text-sm">🐄</div>
          <div><div className="font-display text-[10px] font-bold text-fg leading-tight">Haveri Milk Union</div><div className="text-[8px] text-muted-fg font-medium">ERP System</div></div>
        </div>
        {user && <div className="mt-2.5 bg-muted border border-border rounded-md px-2.5 py-1.5 text-[10px] font-semibold text-muted-fg flex items-center justify-between">{user.role.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}<ChevronDown className="h-2.5 w-2.5" /></div>}
      </div>
      <nav className="flex-1 py-2 overflow-y-auto">
        <Link href="/dashboard" className={cn("flex items-center gap-2.5 px-4 py-[7px] mx-1.5 rounded-lg text-[11px] font-semibold mb-1 transition-colors", pathname === "/dashboard" ? "bg-brand-light text-brand" : "text-muted-fg hover:bg-muted hover:text-fg")}><LayoutDashboard className="h-[14px] w-[14px]" /> Dashboard</Link>
        {NAV_GROUPS.map((g) => <SidebarGroup key={g.label} label={g.label} items={g.items} pathname={pathname} />)}
      </nav>
      <div className="px-4 py-3 border-t border-border"><p className="text-[9px] text-muted-fg font-medium">v1.0 · Haveri Milk Union ERP</p></div>
    </aside>
  );
}
