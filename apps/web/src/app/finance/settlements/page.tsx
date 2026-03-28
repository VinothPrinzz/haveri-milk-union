"use client";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { formatCurrency } from "@/lib/utils";
import { PageHeader, StatCard, TableCard, Th, Td, Badge, Button } from "@/components/ui";
import { Download } from "lucide-react";
import { exportCSV } from "@/lib/export";
export default function SettlementsPage() {
  const { data } = useQuery({ queryKey: ["settlements"], queryFn: () => api.get("/api/v1/settlements", { page: 1, limit: 50 }) });
  const rows = data?.data ?? [];
  const totalSettled = rows.filter((s: any)=>s.status==="processed").reduce((a: number,s: any)=>a+parseFloat(s.total_amount),0);
  const totalPending = rows.filter((s: any)=>s.status==="pending").reduce((a: number,s: any)=>a+parseFloat(s.total_amount),0);
  const handleExport = () => exportCSV(rows.map((s: any) => ({ Date: new Date(s.settlement_date).toLocaleDateString("en-IN"), Amount: s.total_amount, Dealers: s.dealer_count, Reference: s.bank_reference||"", Status: s.status })), "settlements");
  return (
    <>
      <PageHeader icon="🏦" title="Settlements" subtitle="Batch settlement records and payment processing"
        actions={<Button variant="outline" size="sm" onClick={handleExport}><Download className="h-3.5 w-3.5" /> Export</Button>} />
      <div className="grid grid-cols-3 gap-4 mb-6">
        <StatCard icon="✅" iconBg="bg-success/10 text-success" value={formatCurrency(totalSettled)} label="Total Settled" />
        <StatCard icon="⏳" iconBg="bg-warning/10 text-warning" value={formatCurrency(totalPending)} label="Pending" />
        <StatCard icon="📊" iconBg="bg-brand-light text-brand" value={rows.length} label="Total Records" />
      </div>
      <TableCard>
        <thead><tr><Th>Date</Th><Th className="text-right">Amount</Th><Th className="text-right">Dealers</Th><Th>Bank Reference</Th><Th>Status</Th></tr></thead>
        <tbody>{rows.map((s: any) => (<tr key={s.id} className="hover:bg-muted/50"><Td className="font-semibold">{new Date(s.settlement_date).toLocaleDateString("en-IN")}</Td><Td className="text-right font-bold">{formatCurrency(s.total_amount)}</Td><Td className="text-right">{s.dealer_count}</Td><Td className="font-mono text-[10px] text-muted-fg">{s.bank_reference||"—"}</Td><Td><Badge variant={s.status==="processed"?"active":"pending"}>{s.status}</Badge></Td></tr>
        ))}{rows.length===0&&<tr><td colSpan={5} className="text-center py-8 text-muted-fg text-[12px]">No settlement records</td></tr>}</tbody>
      </TableCard>
    </>
  );
}
