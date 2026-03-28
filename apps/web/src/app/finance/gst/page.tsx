"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { formatCurrency } from "@/lib/utils";
import { PageHeader, Card, TableCard, Th, Td, Badge, Button } from "@/components/ui";
import { Download } from "lucide-react";
import { exportCSV } from "@/lib/export";
export default function GSTReportsPage() {
  const [dateFrom, setDateFrom] = useState(""); const [dateTo, setDateTo] = useState("");
  const { data } = useQuery({ queryKey: ["invoices-gst", dateFrom, dateTo], queryFn: () => api.get("/api/v1/invoices", { page: 1, limit: 200, dateFrom: dateFrom||undefined, dateTo: dateTo||undefined }) });
  const invoices = data?.data ?? [];
  const totalTaxable = invoices.reduce((a: number,i: any) => a+parseFloat(i.taxable_amount||0), 0);
  const totalCgst = invoices.reduce((a: number,i: any) => a+parseFloat(i.cgst||0), 0);
  const totalSgst = invoices.reduce((a: number,i: any) => a+parseFloat(i.sgst||0), 0);
  const totalTax = totalCgst + totalSgst;

  const exportGSTR1 = () => exportCSV(invoices.map((i: any) => ({ Invoice: i.invoice_number, Dealer: i.dealer_name, GSTIN: i.dealer_gst_number||"", Date: new Date(i.invoice_date).toLocaleDateString("en-IN"), Taxable: i.taxable_amount, CGST: i.cgst, SGST: i.sgst, Total: i.total_amount })), "GSTR1_report");
  const exportGSTR3B = () => exportCSV([{ Period: dateFrom||"All", TaxableValue: totalTaxable.toFixed(2), CGST: totalCgst.toFixed(2), SGST: totalSgst.toFixed(2), TotalTax: totalTax.toFixed(2) }], "GSTR3B_summary");

  return (
    <>
      <PageHeader icon="📊" title="GST Reports" subtitle="Generate GSTR-1 and GSTR-3B reports for filing"
        actions={<div className="flex gap-2"><Button variant="outline" size="sm" onClick={exportGSTR1}><Download className="h-3.5 w-3.5" /> GSTR-1</Button><Button variant="outline" size="sm" onClick={exportGSTR3B}><Download className="h-3.5 w-3.5" /> GSTR-3B</Button></div>} />
      <div className="flex items-center gap-2 mb-6"><span className="text-[11px] font-semibold text-muted-fg">Period:</span><input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="h-8 bg-card border border-border rounded-lg px-2 text-[10px] font-medium outline-none" /><span className="text-[10px] text-muted-fg">to</span><input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="h-8 bg-card border border-border rounded-lg px-2 text-[10px] font-medium outline-none" /></div>
      <div className="grid grid-cols-4 gap-4 mb-6">
        <div className="bg-card rounded-[10px] border border-border shadow-card p-4 text-center"><div className="font-display text-xl font-bold text-fg">{formatCurrency(totalTaxable)}</div><div className="text-[11px] font-semibold text-muted-fg">Taxable Value</div></div>
        <div className="bg-card rounded-[10px] border border-border shadow-card p-4 text-center"><div className="font-display text-xl font-bold text-brand">{formatCurrency(totalCgst)}</div><div className="text-[11px] font-semibold text-muted-fg">CGST</div></div>
        <div className="bg-card rounded-[10px] border border-border shadow-card p-4 text-center"><div className="font-display text-xl font-bold text-brand">{formatCurrency(totalSgst)}</div><div className="text-[11px] font-semibold text-muted-fg">SGST</div></div>
        <div className="bg-card rounded-[10px] border border-border shadow-card p-4 text-center"><div className="font-display text-xl font-bold text-fg">{formatCurrency(totalTax)}</div><div className="text-[11px] font-semibold text-muted-fg">Total Tax</div></div>
      </div>
      <Card title="Invoice-wise Breakdown (GSTR-1)"><div className="overflow-x-auto"><table className="w-full border-collapse">
        <thead><tr><Th>Invoice No.</Th><Th>Dealer</Th><Th>Date</Th><Th className="text-right">Taxable</Th><Th className="text-right">CGST</Th><Th className="text-right">SGST</Th><Th className="text-right">Total</Th></tr></thead>
        <tbody>{invoices.map((i: any) => (<tr key={i.id} className="hover:bg-muted/50"><Td className="font-mono text-[10px] font-semibold">{i.invoice_number}</Td><Td>{i.dealer_name}</Td><Td className="text-muted-fg">{new Date(i.invoice_date).toLocaleDateString("en-IN")}</Td><Td className="text-right">{formatCurrency(i.taxable_amount)}</Td><Td className="text-right text-muted-fg">{formatCurrency(i.cgst)}</Td><Td className="text-right text-muted-fg">{formatCurrency(i.sgst)}</Td><Td className="text-right font-semibold">{formatCurrency(i.total_amount)}</Td></tr>
        ))}</tbody>
      </table></div></Card>
    </>
  );
}
