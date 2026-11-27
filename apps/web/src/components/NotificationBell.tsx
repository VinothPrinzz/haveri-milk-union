// apps/web/src/components/NotificationBell.tsx
// Top-bar bell: staff notifications for the signed-in role (dealers' product
// demand, route officers' shortage entries, …). Polls every minute; a click
// on an item marks it read and opens its page.
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, PackageSearch, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  fetchStaffNotifications, markAllStaffNotificationsRead, markStaffNotificationRead,
  type StaffNotification,
} from "@/services/notifications";

const ago = (iso: string) => {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
};

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const qc = useQueryClient();

  const { data } = useQuery({
    queryKey: ["staff-notifications"],
    queryFn: fetchStaffNotifications,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    // A missing table / older API must not break the top bar.
    retry: false,
  });
  const items = data?.data ?? [];
  const unread = data?.unread ?? 0;

  const refresh = () => qc.invalidateQueries({ queryKey: ["staff-notifications"] });
  const readOne = useMutation({ mutationFn: markStaffNotificationRead, onSuccess: refresh });
  const readAll = useMutation({ mutationFn: markAllStaffNotificationsRead, onSuccess: refresh });

  // Close on an outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const openItem = (n: StaffNotification) => {
    if (!n.read) readOne.mutate(n.id);
    setOpen(false);
    if (n.link) navigate(n.link);
  };

  return (
    <div className="relative" ref={box}>
      <button
        className="relative p-1.5 hover:bg-white/10 rounded-sm"
        title={unread ? `${unread} new notification${unread === 1 ? "" : "s"}` : "Notifications"}
        onClick={() => setOpen(v => !v)}
      >
        <Bell className="w-4 h-4" />
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-warning text-[10px] leading-4 font-semibold text-black text-center">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-[360px] max-w-[90vw] bg-panel text-foreground border border-border shadow-lg rounded-sm z-50">
          <div className="flex items-center justify-between px-3 py-2 border-b border-border">
            <span className="text-[12.5px] font-semibold">Notifications</span>
            {unread > 0 && (
              <button className="text-[11.5px] text-primary hover:underline" onClick={() => readAll.mutate()}>
                Mark all read
              </button>
            )}
          </div>
          <div className="max-h-[420px] overflow-auto">
            {items.length === 0 ? (
              <p className="px-3 py-6 text-center text-[12px] text-muted-foreground">No notifications</p>
            ) : items.map(n => {
              const Icon = n.kind === "product_demand" ? PackageSearch : TriangleAlert;
              return (
                <button
                  key={n.id}
                  onClick={() => openItem(n)}
                  className={cn(
                    "w-full text-left flex gap-2 px-3 py-2 border-b border-border/60 last:border-0 hover:bg-accent",
                    !n.read && "bg-primary/5",
                  )}
                >
                  <Icon className={cn("h-4 w-4 mt-0.5 shrink-0", n.kind === "product_demand" ? "text-info" : "text-warning")} />
                  <span className="min-w-0 flex-1">
                    <span className={cn("block text-[12.5px] truncate", !n.read && "font-semibold")}>{n.title}</span>
                    {n.body && <span className="block text-[11.5px] text-muted-foreground line-clamp-2">{n.body}</span>}
                    <span className="block text-[10.5px] text-muted-foreground mt-0.5">{ago(n.createdAt)}</span>
                  </span>
                  {!n.read && <span className="mt-1.5 h-2 w-2 rounded-full bg-primary shrink-0" />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
