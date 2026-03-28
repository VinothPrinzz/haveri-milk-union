"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { formatCurrency } from "@/lib/utils";
import { PageHeader, Badge, Button, TableCard, Th, Td } from "@/components/ui";
import { Download, Eye, Search } from "lucide-react";
import { exportCSV } from "@/lib/export";
export default function InvoicesPage() {
  const [search, setSearch] = useState(""); const [dealerFilter, setDealerFilter] = useState(""); const [dateFrom, setDateFrom] = useState(""); const [dateTo, setDateTo] = useState(""); const [page, setPage] = useState(1);
  const { data } = useQuery({ queryKey: ["invoices", page, dealerFilter, dateFrom, dateTo], queryFn: () => api.get("/api/v1/invoices", { page, limit: 25, dealer: dealerFilter||undefined, dateFrom: dateFrom||undefined, dateTo: dateTo||undefined }) });
  let invoices = data?.data ?? []; const total = data?.total ?? 0; const totalPages = data?.totalPages ?? 1;
  if (search) invoices = invoices.filter((i: any) => i.invoice_number?.toLowerCase().includes(search.toLowerCase()));
  const handleExport = () => exportCSV(invoices.map((i: any) => ({ Invoice: i.invoice_number, Dealer: i.dealer_name, Date: new Date(i.invoice_date).toLocaleDateString("en-IN"), Taxable: i.taxable_amount, GST: i.total_tax, Total: i.total_amount })), "invoices");
  return (
    <>
      <PageHeader icon="🧾" title="All Invoices" subtitle="View and download all generated GST invoices"
        actions={<Button variant="outline" size="sm" onClick={handleExport}><Download className="h-3.5 w-3.5" /> Export All</Button>} />
      <div className="flex flex-wrap items-center gap-3 mb-5">
        <div className="flex items-center gap-2 bg-card border border-border rounded-lg px-3 py-2 w-56"><Search className="h-3.5 w-3.5 text-muted-fg" /><input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search invoices..." className="bg-transparent text-[11px] text-fg placeholder-muted-fg outline-none w-full font-medium" /></div>
        <div className="flex items-center gap-2 bg-card border border-border rounded-lg px-3 py-2 w-44"><input type="text" value={dealerFilter} onChange={e => { setDealerFilter(e.target.value); setPage(1); }} placeholder="Filter by dealer..." className="bg-transparent text-[11px] text-fg placeholder-muted-fg outline-none w-full font-medium" /></div>
        <div className="flex items-center gap-1.5"><input type="date" value={dateFrom} onChange={e => { setDateFrom(e.target.value); setPage(1); }} className="h-8 bg-card border border-border rounded-lg px-2 text-[10px] font-medium outline-none" /><span className="text-[10px] text-muted-fg">to</span><input type="date" value={dateTo} onChange={e => { setDateTo(e.target.value); setPage(1); }} className="h-8 bg-card border border-border rounded-lg px-2 text-[10px] font-medium outline-none" /></div>
      </div>
      <TableCard>
        <thead><tr><Th>Invoice No.</Th><Th>Dealer</Th><Th>Date</Th><Th className="text-right">Taxable</Th><Th className="text-right">GST</Th><Th className="text-right">Total</Th><Th>Actions</Th></tr></thead>
        <tbody>{invoices.map((inv: any) => (<tr key={inv.id} className="hover:bg-muted/50"><Td className="font-mono text-[10px] font-semibold">{inv.invoice_number}</Td><Td className="font-semibold">{inv.dealer_name}</Td><Td className="text-muted-fg">{new Date(inv.invoice_date).toLocaleDateString("en-IN")}</Td><Td className="text-right">{formatCurrency(inv.taxable_amount)}</Td><Td className="text-right text-muted-fg">{formatCurrency(inv.total_tax)}</Td><Td className="text-right font-bold">{formatCurrency(inv.total_amount)}</Td>
          <Td><div className="flex gap-1"><button className="p-1.5 rounded-md border border-border hover:bg-muted"><Eye className="h-3.5 w-3.5 text-muted-fg" /></button><button className="p-1.5 rounded-md border border-border hover:bg-muted"><Download className="h-3.5 w-3.5 text-muted-fg" /></button></div></Td></tr>
        ))}{invoices.length===0&&<tr><td colSpan={7} className="text-center py-8 text-muted-fg text-[12px]">No invoices found</td></tr>}</tbody>
      </TableCard>
      {totalPages>1&&<div className="flex items-center justify-between mt-4"><p className="text-[11px] text-muted-fg">Page {page} of {totalPages}</p><div className="flex gap-1.5"><Button variant="outline" size="sm" disabled={page<=1} onClick={()=>setPage(page-1)}>Previous</Button><Button variant="outline" size="sm" disabled={page>=totalPages} onClick={()=>setPage(page+1)}>Next</Button></div></div>}
    </>
  );
}
