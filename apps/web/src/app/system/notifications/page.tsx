"use client";
import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { PageHeader, Badge, TableCard, Th, Td, Button } from "@/components/ui";
import { Save } from "lucide-react";

function Toggle({ on, onChange }: { on: boolean; onChange: () => void }) {
  return (
    <button onClick={onChange} className={`w-9 h-5 rounded-full transition-colors relative ${on ? "bg-brand" : "bg-muted"}`}>
      <div className="absolute top-0.5 w-4 h-4 rounded-full bg-white shadow" style={{ left: on ? "18px" : "2px" }} />
    </button>
  );
}

const DEFAULT_EVENTS = [
  { eventName: "new_indent", label: "New Indent Placed", channel: "Dealers", push: true },
  { eventName: "order_confirmed", label: "Order Confirmed", channel: "Dealers", push: true },
  { eventName: "order_dispatched", label: "Order Dispatched", channel: "Dealers", push: true },
  { eventName: "payment_received", label: "Payment Received", channel: "Admin", push: true },
  { eventName: "low_stock", label: "Low Stock Alert", channel: "Admin", push: true },
  { eventName: "new_registration", label: "New Registration", channel: "Admin", push: true },
  { eventName: "window_opening", label: "Window Opening", channel: "Dealers", push: true },
  { eventName: "window_closing", label: "Window Closing Soon", channel: "Dealers", push: true },
];

export default function NotificationsPage() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["notification-config"], queryFn: () => api.get("/api/v1/notifications/config") });
  const [settings, setSettings] = useState(DEFAULT_EVENTS);

  useEffect(() => {
    if (data?.data?.length) {
      setSettings(prev => prev.map(s => {
        const fromApi = data.data.find((d: any) => d.eventName === s.eventName);
        return fromApi ? { ...s, push: fromApi.pushEnabled === "true" || fromApi.pushEnabled === true } : s;
      }));
    }
  }, [data]);

  const saveMut = useMutation({
    mutationFn: () => api.put("/api/v1/notifications/config", {
      configs: settings.map(s => ({ eventName: s.eventName, pushEnabled: s.push ? "true" : "false" }))
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notification-config"] }),
  });

  const toggle = (idx: number) => setSettings(prev => prev.map((s, i) => i === idx ? { ...s, push: !s.push } : s));

  return (
    <>
      <PageHeader icon="🔔" title="Notifications" subtitle="Configure push notification settings"
        actions={<Button size="sm" disabled={saveMut.isPending} onClick={() => saveMut.mutate()}>
          <Save className="h-3.5 w-3.5" /> {saveMut.isPending ? "Saving..." : saveMut.isSuccess ? "Saved ✓" : "Save Settings"}
        </Button>} />
      <TableCard>
        <thead><tr><Th>Event</Th><Th>Channel</Th><Th className="text-center">📱 Push Notification</Th></tr></thead>
        <tbody>{settings.map((e, i) => (
          <tr key={e.eventName} className="hover:bg-muted/50"><Td className="font-semibold">{e.label}</Td><Td><Badge variant={e.channel === "Admin" ? "badge-brand" : "active"}>{e.channel}</Badge></Td><Td className="text-center"><Toggle on={e.push} onChange={() => toggle(i)} /></Td></tr>
        ))}</tbody>
      </TableCard>
    </>
  );
}
