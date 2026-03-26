"use client";
import { PageHeader, StatCard, TableCard, Th, Td, Badge, Button } from "@/components/ui";
import { formatCurrency } from "@/lib/utils";
import { Download } from "lucide-react";
const DATA = [
  { date: "23 Jan 2025", amount: 45000, dealers: 12, ref: "NEFT-20250123-001", status: "processed" },
  { date: "22 Jan 2025", amount: 38000, dealers: 10, ref: "NEFT-20250122-001", status: "processed" },
  { date: "21 Jan 2025", amount: 52000, dealers: 15, ref: "—", status: "pending" },
  { date: "20 Jan 2025", amount: 41000, dealers: 11, ref: "NEFT-20250120-001", status: "processed" },
];
export default function SettlementsPage() {
  return (
    <>
      <PageHeader icon="🏦" title="Settlements" subtitle="Batch settlement records and payment processing"
        actions={<Button variant="outline" size="sm"><Download className="h-3.5 w-3.5" /> Export</Button>} />
      <div className="grid grid-cols-3 gap-4 mb-6">
        <StatCard icon="✅" iconBg="bg-success/10 text-success" value="₹1.24L" label="Total Settled" />
        <StatCard icon="⏳" iconBg="bg-warning/10 text-warning" value="₹52K" label="Pending Settlement" />
        <StatCard icon="📊" iconBg="bg-brand-light text-brand" value="48" label="Total Dealers" />
      </div>
      <TableCard>
        <thead><tr><Th>Date</Th><Th className="text-right">Amount</Th><Th className="text-right">Dealers</Th><Th>Bank Reference</Th><Th>Status</Th></tr></thead>
        <tbody>{DATA.map((s, i) => (
          <tr key={i} className="hover:bg-muted/50"><Td className="font-semibold">{s.date}</Td><Td className="text-right font-bold">{formatCurrency(s.amount)}</Td><Td className="text-right">{s.dealers}</Td><Td className="font-mono text-[10px] text-muted-fg">{s.ref}</Td><Td><Badge variant={s.status === "processed" ? "active" : "pending"}>{s.status}</Badge></Td></tr>
        ))}</tbody>
      </TableCard>
    </>
  );
}
