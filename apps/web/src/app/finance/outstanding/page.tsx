"use client";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { formatCurrency } from "@/lib/utils";
import { PageHeader, TableCard, Th, Td, Badge, Button } from "@/components/ui";
import { Download, Bell } from "lucide-react";
import { exportCSV } from "@/lib/export";
export default function OutstandingPage() {
  const { data } = useQuery({ queryKey: ["outstanding"], queryFn: () => api.get("/api/v1/outstanding") });
  const rows = data?.data ?? []; const summary = data?.summary ?? {};
  const handleExport = () => exportCSV(rows.map((d: any) => ({ Dealer: d.name, Location: d.zone_name, Outstanding: d.outstanding, Overdue: d.overdue, Status: d.payment_status })), "outstanding_dues");
  return (
    <>
      <PageHeader icon="⚡" title="Outstanding / Dues" subtitle="Pending payments and overdue accounts"
        actions={<Button variant="outline" size="sm" onClick={handleExport}><Download className="h-3.5 w-3.5" /> Export</Button>} />
      <div className="grid grid-cols-2 gap-4 mb-6">
        <div className="bg-card rounded-[10px] border-2 border-warning/20 shadow-card p-4 text-center" style={{background:"rgba(217,119,6,.05)"}}><div className="font-display text-[22px] font-bold text-warning">{formatCurrency(summary.totalOutstanding||0)}</div><div className="text-[11px] font-semibold text-muted-fg">Total Outstanding</div></div>
        <div className="bg-card rounded-[10px] border-2 border-danger/20 shadow-card p-4 text-center" style={{background:"rgba(220,38,38,.05)"}}><div className="font-display text-[22px] font-bold text-danger">{formatCurrency(summary.totalOverdue||0)}</div><div className="text-[11px] font-semibold text-muted-fg">Overdue</div></div>
      </div>
      <TableCard>
        <thead><tr><Th>Dealer</Th><Th>Location</Th><Th className="text-right">Outstanding</Th><Th className="text-right">Overdue</Th><Th>Status</Th><Th>Action</Th></tr></thead>
        <tbody>{rows.map((d: any) => (<tr key={d.id} className={`hover:bg-muted/50 ${d.payment_status==="overdue"?"bg-warning/[0.03]":d.payment_status==="critical"?"bg-danger/[0.03]":""}`}>
          <Td className="font-semibold">{d.name}</Td><Td className="text-muted-fg">{d.zone_name}</Td><Td className="text-right font-bold">{formatCurrency(d.outstanding)}</Td>
          <Td className="text-right">{parseFloat(d.overdue)>0?<span className="text-danger font-semibold">{formatCurrency(d.overdue)}</span>:<span className="text-muted-fg">—</span>}</Td>
          <Td><Badge variant={d.payment_status==="current"?"active":d.payment_status==="overdue"?"pending":"cancelled"}>{d.payment_status}</Badge></Td>
          <Td><button className="p-1.5 rounded-md border border-border hover:bg-muted"><Bell className="h-3.5 w-3.5 text-muted-fg" /></button></Td>
        </tr>))}{rows.length===0&&<tr><td colSpan={6} className="text-center py-8 text-muted-fg text-[12px]">No outstanding dues</td></tr>}</tbody>
      </TableCard>
    </>
  );
}
