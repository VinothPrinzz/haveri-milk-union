import { Link, useLocation } from "react-router-dom";
import {
  Users, Truck, MapPin, Package, Home as HomeIcon,
  BarChart3, Warehouse, ClipboardList, ShoppingCart,
  TrendingUp, Map, FileSpreadsheet, ChevronDown,
  Settings, XCircle, Bell, Image, Shield, UserCog,
  Timer, FileText, BookOpen, Receipt, Zap, CreditCard, Send,
  LayoutList,
} from "lucide-react";
import {
  Sidebar, SidebarContent, SidebarGroup, SidebarGroupContent,
  SidebarGroupLabel, SidebarMenu, SidebarMenuButton, SidebarMenuItem,
  SidebarHeader, SidebarFooter,
} from "@/components/ui/sidebar";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { useState } from "react";

function NavItem({ to, icon: Icon, label }: { to: string; icon: React.ComponentType<{ className?: string }>; label: string }) {
  const location = useLocation();
  const isActive = location.pathname === to;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={isActive}>
        <Link to={to} className={cn(
          "flex items-center gap-2.5 px-3 py-2 text-sm rounded-md w-full transition-colors",
          isActive ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium" : "text-sidebar-foreground/80 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
        )}>
          <Icon className="h-4 w-4 shrink-0" />
          <span>{label}</span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function NavSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <SidebarGroupLabel className="text-[10px] font-semibold uppercase tracking-widest text-sidebar-foreground/40 px-3 mt-2 mb-0.5">{label}</SidebarGroupLabel>
      {children}
    </>
  );
}

function CollapsibleGroup({ icon: Icon, label, children, defaultOpen = false }: {
  icon: React.ComponentType<{ className?: string }>; label: string; children: React.ReactNode; defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button className="flex items-center justify-between w-full px-3 py-2 text-sm text-sidebar-foreground/80 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground rounded-md transition-colors">
          <div className="flex items-center gap-2.5">
            <Icon className="h-4 w-4 shrink-0" />
            <span className="font-medium">{label}</span>
          </div>
          <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="ml-3 pl-3 border-l border-sidebar-border/40 mt-0.5 space-y-0.5">
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function AppSidebar() {
  return (
    <Sidebar>
      <SidebarHeader className="px-4 py-3 border-b border-sidebar-border/40">
        <div>
          <p className="text-sm font-bold text-sidebar-foreground">Haveri Milk Union</p>
          <p className="text-[11px] text-sidebar-foreground/50 mt-0.5">Marketing Module</p>
        </div>
      </SidebarHeader>

      <SidebarContent className="px-2 py-2 gap-0">
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu className="gap-0.5">

              <NavItem to="/" icon={HomeIcon} label="Dashboard" />

              {/* Masters */}
              <CollapsibleGroup icon={LayoutList} label="Masters" defaultOpen>
                <NavSection label="Customers">
                  <NavItem to="/masters/customers" icon={Users} label="All Customers" />
                  <NavItem to="/masters/customers/new" icon={Users} label="New Customer" />
                  <NavItem to="/masters/customers/assign-route" icon={MapPin} label="Assign Route" />
                </NavSection>
                <NavSection label="Contractors">
                  <NavItem to="/masters/contractors" icon={Truck} label="All Contractors" />
                  <NavItem to="/masters/contractors/new" icon={Truck} label="New Contractor" />
                </NavSection>
                <NavSection label="Routes">
                  <NavItem to="/masters/routes" icon={Map} label="All Routes" />
                  <NavItem to="/masters/routes/new" icon={Map} label="New Route" />
                </NavSection>
                <NavSection label="Batches">
                  <NavItem to="/masters/batches" icon={ClipboardList} label="All Batches" />
                  <NavItem to="/masters/batches/new" icon={ClipboardList} label="New Batch" />
                </NavSection>
                <NavSection label="Products">
                  <NavItem to="/masters/products" icon={Package} label="All Products" />
                  <NavItem to="/masters/products/add" icon={Package} label="Add Packet" />
                  <NavItem to="/masters/products/rates" icon={Package} label="Rate Categories" />
                </NavSection>
                <NavSection label="Price Chart">
                  <NavItem to="/masters/price-chart" icon={TrendingUp} label="View Price Chart" />
                </NavSection>
              </CollapsibleGroup>

              {/* Sales Operations */}
              <CollapsibleGroup icon={ShoppingCart} label="Sales Operations" defaultOpen>
                {/* Fix 14: Indents section now has All Indents as separate page */}
                <NavSection label="Indents">
                  <NavItem to="/sales/record-indents" icon={FileText} label="Record Indents" />
                  <NavItem to="/sales/post-indent" icon={Send} label="Post Indent" />
                  <NavItem to="/sales/all-indents" icon={ClipboardList} label="All Indents" />
                </NavSection>
                {/* Fix 16: Direct Sales now has Recent Sales as separate page */}
                <NavSection label="Direct Sales">
                  <NavItem to="/sales/direct-sales/gate-pass" icon={Zap} label="Gate Pass (Agents)" />
                  <NavItem to="/sales/direct-sales/cash-customer" icon={CreditCard} label="Cash Customer" />
                  <NavItem to="/sales/direct-sales/modify" icon={ClipboardList} label="Modify Indent" />
                  <NavItem to="/sales/direct-sales/recent" icon={Receipt} label="Recent Sales" />
                </NavSection>
                <NavSection label="Cancellations">
                  <NavItem to="/sales/cancellations" icon={XCircle} label="Cancellation Requests" />
                </NavSection>
              </CollapsibleGroup>

              {/* FGS Stock */}
              <CollapsibleGroup icon={Warehouse} label="FGS - Stock">
                <NavItem to="/fgs/dashboard" icon={BarChart3} label="Stock Overview" />
                <NavItem to="/fgs/stock-entry" icon={Warehouse} label="Stock Entry" />
                <NavItem to="/fgs/reports" icon={FileSpreadsheet} label="Stock Reports" />
                <NavItem to="/fgs/dispatch-sheet" icon={ClipboardList} label="Dispatch Sheet" />
              </CollapsibleGroup>

              {/* Reports */}
              <CollapsibleGroup icon={BookOpen} label="Reports">
                <NavItem to="/reports/route-sheet" icon={Map} label="Route Sheet" />
                <NavItem to="/reports/gate-pass" icon={FileText} label="Gate Pass Report" />
              </CollapsibleGroup>

              {/* Sales Reports */}
              <CollapsibleGroup icon={TrendingUp} label="Sales Reports">
                <NavItem to="/sales-reports/daily-statement" icon={FileSpreadsheet} label="Daily Sales Statement" />
                <NavItem to="/sales-reports/day-route-cash" icon={FileSpreadsheet} label="Day/Route Wise Cash" />
                <NavItem to="/sales-reports/officer-wise" icon={FileSpreadsheet} label="Officer Wise Sales" />
                <NavItem to="/sales-reports/cash-sales" icon={FileSpreadsheet} label="Cash Sales" />
                <NavItem to="/sales-reports/credit-sales" icon={FileSpreadsheet} label="Credit Sales" />
                <NavItem to="/sales-reports/register" icon={FileSpreadsheet} label="Sales Register" />
                <NavItem to="/sales-reports/taluka-agent" icon={FileSpreadsheet} label="Taluka/Agent Wise" />
                <NavItem to="/sales-reports/adhoc" icon={FileSpreadsheet} label="Adhoc Sales" />
                <NavItem to="/sales-reports/gst" icon={FileSpreadsheet} label="GST Statement" />
              </CollapsibleGroup>

              {/* System */}
              <CollapsibleGroup icon={Settings} label="System">
                <NavItem to="/system/time-windows" icon={Timer} label="Time Windows" />
                <NavItem to="/system/notifications" icon={Bell} label="Notifications" />
                <NavItem to="/system/dealer-notifications" icon={Bell} label="Dealer Notifications" />
                <NavItem to="/system/banners" icon={Image} label="Banner Management" />
                <NavItem to="/system/roles" icon={Shield} label="Roles & Access" />
                <NavItem to="/system/users" icon={UserCog} label="User Management" />
              </CollapsibleGroup>

            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="px-4 py-2 border-t border-sidebar-border/40">
        <p className="text-[10px] text-sidebar-foreground/30">v1.0 — Haveri Dairy</p>
      </SidebarFooter>
    </Sidebar>
  );
}
