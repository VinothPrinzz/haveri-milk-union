"use client";
import { Search, Bell, Menu } from "lucide-react";
import { useAuthStore } from "@/lib/auth-store";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export function Topbar() {
  const user = useAuthStore((s) => s.user);

  const { data: windowData } = useQuery({
    queryKey: ["window-status"],
    queryFn: () => api.get("/api/v1/window/status"),
    refetchInterval: 30000, // poll every 30s
  });

  // Find if any window is open
  const openWindow = windowData?.windows?.find(
    (w: any) => w.state === "open" || w.state === "warning"
  );

  const initials = user?.name
    ? user.name
        .split(" ")
        .map((w: string) => w[0])
        .join("")
        .slice(0, 2)
        .toUpperCase()
    : "AD";

  return (
    <header className="h-[52px] bg-card border-b border-border flex items-center gap-3 px-4 sticky top-0 z-30">
      {/* Hamburger (mobile only in future) */}
      <button className="lg:hidden p-1.5 rounded-lg border border-border text-muted-fg hover:bg-muted">
        <Menu className="h-4 w-4" />
      </button>

      {/* Search */}
      <div className="flex-1 max-w-[400px]">
        <div className="flex items-center gap-2 bg-background border border-border rounded-full px-3.5 py-1.5">
          <Search className="h-3.5 w-3.5 text-muted-fg" />
          <input
            type="text"
            placeholder="Search orders, dealers, products..."
            className="bg-transparent text-[11px] text-fg placeholder-muted-fg outline-none w-full font-medium"
          />
        </div>
      </div>

      {/* Right side */}
      <div className="flex items-center gap-2.5 ml-auto">
        {/* Window status badge */}
        {openWindow ? (
          <div className="bg-success/10 border border-success/20 rounded-full px-3 py-1 text-[10px] font-bold text-success">
            ⏱ Window Open · {openWindow.openTime}–{openWindow.closeTime}
          </div>
        ) : (
          <div className="bg-muted border border-border rounded-full px-3 py-1 text-[10px] font-bold text-muted-fg">
            ⏱ Window Closed
          </div>
        )}

        {/* Notification bell */}
        <button className="relative w-8 h-8 rounded-lg bg-background border border-border flex items-center justify-center hover:bg-muted transition-colors">
          <Bell className="h-3.5 w-3.5 text-muted-fg" />
          <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 bg-danger rounded-full border border-white" />
        </button>

        {/* User avatar */}
        <div className="w-8 h-8 rounded-lg bg-brand flex items-center justify-center font-display text-[10px] font-bold text-white">
          {initials}
        </div>

        {/* User name */}
        {user && (
          <div className="hidden sm:block">
            <div className="text-[11px] font-bold text-fg">{user.name}</div>
            <div className="text-[9px] font-medium text-muted-fg">
              Haveri Milk Union
            </div>
          </div>
        )}
      </div>
    </header>
  );
}
