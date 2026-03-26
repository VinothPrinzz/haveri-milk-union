"use client";
import { PageHeader, TableCard, Th, Td, Badge, Button } from "@/components/ui";
import { formatCurrency } from "@/lib/utils";
import { Download, Bell } from "lucide-react";
const DATA = [
  { dealer: "Raju Agencies", loc: "Haveri", outstanding: 4500, overdue: 0, lastPay: "23 Jan", status: "current" },
  { dealer: "Krishna Stores", loc: "Ranebennur", outstanding: 12800, overdue: 5200, lastPay: "18 Jan", status: "overdue" },
  { dealer: "Laxmi Traders", loc: "Savanur", outstanding: 8900, overdue: 8900, lastPay: "10 Jan", status: "critical" },
  { dealer: "Ganesh Dairy", loc: "Byadgi", outstanding: 2100, overdue: 0, lastPay: "22 Jan", status: "current" },
  { dealer: "Mahalakshmi Agency", loc: "Hirekerur", outstanding: 6700, overdue: 3200, lastPay: "15 Jan", status: "overdue" },
];
export default function OutstandingPage() {
  const totalOut = DATA.reduce((a, d) => a + d.outstanding, 0);
  const totalOvd = DATA.reduce((a, d) => a + d.overdue, 0);
  return (
    <>
      <PageHeader icon="⚡" title="Outstanding / Dues" subtitle="Pending payments and overdue accounts"
        actions={<Button variant="outline" size="sm"><Download className="h-3.5 w-3.5" /> Export</Button>} />
      <div className="grid grid-cols-2 gap-4 mb-6">
        <div className="bg-card rounded-[10px] border-2 border-warning/20 shadow-card p-4 text-center" style={{background:"rgba(217,119,6,.05)"}}><div className="font-display text-[22px] font-bold text-warning">{formatCurrency(totalOut)}</div><div className="text-[11px] font-semibold text-muted-fg">Total Outstanding</div></div>
        <div className="bg-card rounded-[10px] border-2 border-danger/20 shadow-card p-4 text-center" style={{background:"rgba(220,38,38,.05)"}}><div className="font-display text-[22px] font-bold text-danger">{formatCurrency(totalOvd)}</div><div className="text-[11px] font-semibold text-muted-fg">Overdue Amount</div></div>
      </div>
      <TableCard>
        <thead><tr><Th>Dealer</Th><Th>Location</Th><Th className="text-right">Outstanding</Th><Th className="text-right">Overdue</Th><Th>Last Payment</Th><Th>Status</Th><Th>Action</Th></tr></thead>
        <tbody>{DATA.map((d, i) => (
          <tr key={i} className={`hover:bg-muted/50 ${d.status === "overdue" ? "bg-warning/[0.03]" : d.status === "critical" ? "bg-danger/[0.03]" : ""}`}>
            <Td className="font-semibold">{d.dealer}</Td><Td className="text-muted-fg">{d.loc}</Td><Td className="text-right font-bold">{formatCurrency(d.outstanding)}</Td>
            <Td className="text-right">{d.overdue > 0 ? <span className="text-danger font-semibold">{formatCurrency(d.overdue)}</span> : <span className="text-muted-fg">—</span>}</Td>
            <Td className={d.status === "critical" ? "text-danger" : "text-muted-fg"}>{d.lastPay}</Td><Td><Badge variant={d.status === "current" ? "active" : d.status === "overdue" ? "pending" : "cancelled"}>{d.status}</Badge></Td>
            <Td><button className="p-1.5 rounded-md border border-border hover:bg-muted"><Bell className="h-3.5 w-3.5 text-muted-fg" /></button></Td>
          </tr>
        ))}</tbody>
      </TableCard>
    </>
  );
}
