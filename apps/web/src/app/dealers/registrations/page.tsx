"use client";
import { PageHeader, Badge, TableCard, Th, Td, Button } from "@/components/ui";
import { Eye, Check, X } from "lucide-react";
const REGS = [
  { id: "REG-001", name: "Venkatesh Stores", phone: "9876543220", loc: "Haveri", gst: "29ABCDE1234F1Z5", date: "23 Jan 2025", status: "pending" },
  { id: "REG-002", name: "Basavaraj Agencies", phone: "9876543221", loc: "Ranebennur", gst: "29FGHIJ5678K2Y4", date: "22 Jan 2025", status: "pending" },
  { id: "REG-003", name: "Shivakumar Dairy", phone: "9876543222", loc: "Savanur", gst: "—", date: "21 Jan 2025", status: "approved" },
  { id: "REG-004", name: "Mahadevi Enterprises", phone: "9876543223", loc: "Byadgi", gst: "29KLMNO9012P3X3", date: "20 Jan 2025", status: "rejected" },
];
export default function RegistrationsPage() {
  const pendingCount = REGS.filter(r => r.status === "pending").length;
  return (
    <>
      <PageHeader icon="👤" title="Registrations" subtitle="New dealer registration requests"
        actions={<Badge variant="pending" className="text-[11px] px-3 py-1">{pendingCount} Pending</Badge>} />
      <TableCard>
        <thead><tr><Th>Reg ID</Th><Th>Dealer Name</Th><Th>Phone</Th><Th>Location</Th><Th>GST</Th><Th>Date</Th><Th>Status</Th><Th>Actions</Th></tr></thead>
        <tbody>{REGS.map(r => (
          <tr key={r.id} className="hover:bg-muted/50">
            <Td className="font-semibold text-[11px]">{r.id}</Td><Td className="font-semibold">{r.name}</Td><Td>{r.phone}</Td><Td>{r.loc}</Td><Td className="font-mono text-[10px] text-muted-fg">{r.gst}</Td><Td className="text-muted-fg">{r.date}</Td><Td><Badge variant={r.status}>{r.status}</Badge></Td>
            <Td><div className="flex gap-1">
              <button className="p-1.5 rounded-md border border-border hover:bg-muted"><Eye className="h-3.5 w-3.5 text-muted-fg" /></button>
              {r.status === "pending" && <><button className="p-1.5 rounded-md border border-success/30 hover:bg-success/10"><Check className="h-3.5 w-3.5 text-success" /></button><button className="p-1.5 rounded-md border border-danger/30 hover:bg-danger/10"><X className="h-3.5 w-3.5 text-danger" /></button></>}
            </div></Td>
          </tr>
        ))}</tbody>
      </TableCard>
    </>
  );
}
