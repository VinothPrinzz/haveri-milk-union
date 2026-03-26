"use client";
import { PageHeader, StatCard, Card, TableCard, Th, Td, Badge, Button } from "@/components/ui";
import { formatCurrency } from "@/lib/utils";
import { Download } from "lucide-react";

const GSTR1 = [
  { inv: "INV-HMU-2025-0471", dealer: "Raju Agencies", date: "23 Jan", taxable: 889, cgst: 22.23, sgst: 22.23, total: 933.46 },
  { inv: "INV-HMU-2025-0344", dealer: "Raju Agencies", date: "22 Jan", taxable: 755, cgst: 18.5, sgst: 18.5, total: 792 },
  { inv: "INV-HMU-2025-0290", dealer: "Krishna Stores", date: "22 Jan", taxable: 1200, cgst: 36, sgst: 36, total: 1272 },
  { inv: "INV-HMU-2025-0210", dealer: "Ganesh Dairy", date: "20 Jan", taxable: 980, cgst: 29.4, sgst: 29.4, total: 1038.8 },
  { inv: "INV-HMU-2025-0185", dealer: "Laxmi Traders", date: "19 Jan", taxable: 650, cgst: 16.25, sgst: 16.25, total: 682.5 },
];
const MONTHLY = [
  { month: "January 2025", taxable: 125000, cgst: 3125, sgst: 3125, total: 131250, status: "pending" },
  { month: "December 2024", taxable: 118000, cgst: 2950, sgst: 2950, total: 123900, status: "filed" },
  { month: "November 2024", taxable: 105000, cgst: 2625, sgst: 2625, total: 110250, status: "filed" },
];

export default function GSTReportsPage() {
  return (
    <>
      <PageHeader icon="📊" title="GST Reports" subtitle="Generate GSTR-1 and GSTR-3B reports for filing"
        actions={<div className="flex gap-2"><Button variant="outline" size="sm"><Download className="h-3.5 w-3.5" /> GSTR-1</Button><Button variant="outline" size="sm"><Download className="h-3.5 w-3.5" /> GSTR-3B</Button></div>} />

      <div className="grid grid-cols-4 gap-4 mb-6">
        <div className="bg-card rounded-[10px] border border-border shadow-card p-4 text-center">
          <div className="font-display text-xl font-bold text-fg">₹1.25L</div><div className="text-[11px] font-semibold text-muted-fg">Taxable Value</div>
        </div>
        <div className="bg-card rounded-[10px] border border-border shadow-card p-4 text-center">
          <div className="font-display text-xl font-bold text-brand">₹3,125</div><div className="text-[11px] font-semibold text-muted-fg">CGST</div>
        </div>
        <div className="bg-card rounded-[10px] border border-border shadow-card p-4 text-center">
          <div className="font-display text-xl font-bold text-brand">₹3,125</div><div className="text-[11px] font-semibold text-muted-fg">SGST</div>
        </div>
        <div className="bg-card rounded-[10px] border border-border shadow-card p-4 text-center">
          <div className="font-display text-xl font-bold text-fg">₹6,250</div><div className="text-[11px] font-semibold text-muted-fg">Total Tax</div>
        </div>
      </div>

      <Card title="Invoice-wise Breakdown (GSTR-1)" className="mb-6">
        <div className="overflow-x-auto"><table className="w-full border-collapse">
          <thead><tr><Th>Invoice No.</Th><Th>Dealer</Th><Th>Date</Th><Th className="text-right">Taxable Value</Th><Th className="text-right">CGST</Th><Th className="text-right">SGST</Th><Th className="text-right">Invoice Total</Th></tr></thead>
          <tbody>{GSTR1.map(r => (
            <tr key={r.inv} className="hover:bg-muted/50"><Td className="font-mono text-[10px] font-semibold">{r.inv}</Td><Td>{r.dealer}</Td><Td className="text-muted-fg">{r.date}</Td><Td className="text-right">{formatCurrency(r.taxable)}</Td><Td className="text-right text-muted-fg">{formatCurrency(r.cgst)}</Td><Td className="text-right text-muted-fg">{formatCurrency(r.sgst)}</Td><Td className="text-right font-semibold">{formatCurrency(r.total)}</Td></tr>
          ))}</tbody>
        </table></div>
      </Card>

      <Card title="📅 Monthly Summary">
        <div className="overflow-x-auto"><table className="w-full border-collapse">
          <thead><tr><Th>Month</Th><Th className="text-right">Taxable</Th><Th className="text-right">CGST</Th><Th className="text-right">SGST</Th><Th className="text-right">Total</Th><Th>Status</Th><Th>Action</Th></tr></thead>
          <tbody>{MONTHLY.map(m => (
            <tr key={m.month} className="hover:bg-muted/50"><Td className="font-semibold">{m.month}</Td><Td className="text-right">{formatCurrency(m.taxable)}</Td><Td className="text-right text-muted-fg">{formatCurrency(m.cgst)}</Td><Td className="text-right text-muted-fg">{formatCurrency(m.sgst)}</Td><Td className="text-right font-bold">{formatCurrency(m.total)}</Td><Td><Badge variant={m.status === "filed" ? "active" : "pending"}>{m.status}</Badge></Td><Td><Button variant="outline" size="sm">📥 Download</Button></Td></tr>
          ))}</tbody>
        </table></div>
      </Card>
    </>
  );
}
