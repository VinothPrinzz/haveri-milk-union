"use client";
import { Bell, Menu } from "lucide-react";
import { useAuthStore } from "@/lib/auth-store";

export function Topbar() {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);

  const initials = user?.name
    ? user.name.split(" ").map((w: string) => w[0]).join("").slice(0, 2).toUpperCase()
    : "AD";

  return (
    <header className="h-[52px] bg-card border-b border-border flex items-center gap-3 px-4 sticky top-0 z-30">
      {/* Hamburger (mobile) */}
      <button className="lg:hidden p-1.5 rounded-lg border border-border text-muted-fg hover:bg-muted">
        <Menu className="h-4 w-4" />
      </button>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Right side */}
      <div className="flex items-center gap-2.5">
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
            <div className="text-[9px] font-medium text-muted-fg">Haveri Milk Union</div>
          </div>
        )}
      </div>
    </header>
  );
}
