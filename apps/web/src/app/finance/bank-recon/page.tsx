"use client";
import { PageHeader, StatCard, TableCard, Th, Td, Badge, Button } from "@/components/ui";
import { formatCurrency } from "@/lib/utils";
import { Upload, Download } from "lucide-react";
const DATA = [
  { date: "23 Jan", ref: "NEFT-001", type: "Settlement", bank: 45000, system: 45000, matched: true },
  { date: "22 Jan", ref: "NEFT-002", type: "Settlement", bank: 38000, system: 38000, matched: true },
  { date: "21 Jan", ref: "UPI-045", type: "Wallet Topup", bank: 5000, system: 5000, matched: true },
  { date: "20 Jan", ref: "NEFT-003", type: "Settlement", bank: 41000, system: 42200, matched: false },
  { date: "19 Jan", ref: "UPI-042", type: "Wallet Topup", bank: 3000, system: 2000, matched: false },
  { date: "18 Jan", ref: "NEFT-004", type: "Settlement", bank: 36000, system: 36000, matched: true },
];
export default function BankReconPage() {
  return (
    <>
      <PageHeader icon="🏛️" title="Bank Reconciliation" subtitle="Match payment records with bank statements"
        actions={<div className="flex gap-2"><Button variant="outline" size="sm"><Upload className="h-3.5 w-3.5" /> Upload Statement</Button><Button variant="outline" size="sm"><Download className="h-3.5 w-3.5" /> Export</Button></div>} />
      <div className="grid grid-cols-2 gap-4 mb-6">
        <div className="bg-card rounded-[10px] border-2 border-success/20 shadow-card p-4 text-center" style={{background:"rgba(22,163,74,.05)"}}><div className="font-display text-[28px] font-black text-success">4</div><div className="text-[11px] font-semibold text-muted-fg">Matched</div></div>
        <div className="bg-card rounded-[10px] border-2 border-danger/20 shadow-card p-4 text-center" style={{background:"rgba(220,38,38,.05)"}}><div className="font-display text-[28px] font-black text-danger">2</div><div className="text-[11px] font-semibold text-muted-fg">Discrepancies</div></div>
      </div>
      <TableCard>
        <thead><tr><Th>Date</Th><Th>Reference</Th><Th>Type</Th><Th className="text-right">Bank Amount</Th><Th className="text-right">System Amount</Th><Th>Match</Th></tr></thead>
        <tbody>{DATA.map((r, i) => (
          <tr key={i} className={`hover:bg-muted/50 ${!r.matched ? "bg-danger/[0.03]" : ""}`}><Td>{r.date}</Td><Td className="font-mono text-[10px]">{r.ref}</Td><Td>{r.type}</Td><Td className="text-right font-semibold">{formatCurrency(r.bank)}</Td><Td className="text-right font-semibold">{formatCurrency(r.system)}</Td><Td><Badge variant={r.matched ? "active" : "cancelled"}>{r.matched ? "✓ Matched" : "⚠ Mismatch"}</Badge></Td></tr>
        ))}</tbody>
      </TableCard>
    </>
  );
}
