"use client";
import { PageHeader, Badge, TableCard, Th, Td, Button } from "@/components/ui";
import { Save } from "lucide-react";
import { useState } from "react";

const EVENTS = [
  { event: "New Indent Placed", channel: "Dealers", push: true },
  { event: "Order Confirmed", channel: "Dealers", push: true },
  { event: "Order Dispatched", channel: "Dealers", push: true },
  { event: "Payment Received", channel: "Admin", push: true },
  { event: "Low Stock Alert", channel: "Admin", push: true },
  { event: "New Registration", channel: "Admin", push: true },
  { event: "Window Opening", channel: "Dealers", push: true },
  { event: "Window Closing Soon", channel: "Dealers", push: true },
];

function Toggle({ on, onChange }: { on: boolean; onChange: () => void }) {
  return (
    <button onClick={onChange} className={`w-9 h-5 rounded-full transition-colors relative ${on ? "bg-brand" : "bg-muted"}`}>
      <div className="absolute top-0.5 w-4 h-4 rounded-full bg-white shadow" style={{ left: on ? "18px" : "2px" }} />
    </button>
  );
}

export default function NotificationsPage() {
  const [settings, setSettings] = useState(EVENTS);
  const toggle = (idx: number) => {
    setSettings(prev => prev.map((s, i) => i === idx ? { ...s, push: !s.push } : s));
  };
  return (
    <>
      <PageHeader icon="🔔" title="Notifications" subtitle="Configure push notification settings"
        actions={<Button size="sm"><Save className="h-3.5 w-3.5" /> Save Settings</Button>} />
      <TableCard>
        <thead><tr><Th>Event</Th><Th>Channel</Th><Th className="text-center">📱 Push Notification</Th></tr></thead>
        <tbody>{settings.map((e, i) => (
          <tr key={e.event} className="hover:bg-muted/50">
            <Td className="font-semibold">{e.event}</Td>
            <Td><Badge variant={e.channel === "Admin" ? "badge-brand" : "active"}>{e.channel}</Badge></Td>
            <Td className="text-center"><Toggle on={e.push} onChange={() => toggle(i)} /></Td>
          </tr>
        ))}</tbody>
      </TableCard>
    </>
  );
}
