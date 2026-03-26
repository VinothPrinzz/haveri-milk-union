"use client";
import { PageHeader, Badge, Button, TableCard, Th, Td, EmptyState } from "@/components/ui";
import { Download, Eye, Printer, Search } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import { useState } from "react";

const INVOICES = [
  { no: "INV-HMU-2025-0471", order: "#HMU-2025-08471", dealer: "Raju Agencies", date: "23 Jan 2025", amount: 889, gst: 44.46, total: 933.46, status: "generated" },
  { no: "INV-HMU-2025-0344", order: "#HMU-2025-08344", dealer: "Raju Agencies", date: "22 Jan 2025", amount: 755, gst: 37, total: 792, status: "generated" },
  { no: "INV-HMU-2025-0290", order: "#HMU-2025-08290", dealer: "Krishna Stores", date: "22 Jan 2025", amount: 1200, gst: 72, total: 1272, status: "generated" },
  { no: "INV-HMU-2025-0250", order: "#HMU-2025-08250", dealer: "Laxmi Traders", date: "21 Jan 2025", amount: 650, gst: 32.5, total: 682.5, status: "cancelled" },
  { no: "INV-HMU-2025-0210", order: "#HMU-2025-08210", dealer: "Ganesh Dairy", date: "20 Jan 2025", amount: 980, gst: 58.8, total: 1038.8, status: "generated" },
];

export default function InvoicesPage() {
  const [search, setSearch] = useState("");
  const filtered = INVOICES.filter(i => search ? i.no.toLowerCase().includes(search.toLowerCase()) || i.dealer.toLowerCase().includes(search.toLowerCase()) : true);

  return (
    <>
      <PageHeader icon="🧾" title="All Invoices" subtitle="View and download all generated GST invoices"
        actions={<Button variant="outline" size="sm"><Download className="h-3.5 w-3.5" /> Export All</Button>} />

      <div className="mb-5">
        <div className="flex items-center gap-2 bg-card border border-border rounded-lg px-3 py-2 max-w-md">
          <Search className="h-4 w-4 text-muted-fg" />
          <input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search invoices..."
            className="bg-transparent text-[12px] text-fg placeholder-muted-fg outline-none w-full font-medium" />
        </div>
      </div>

      <TableCard>
        <thead><tr>
          <Th>Invoice No.</Th><Th>Order</Th><Th>Dealer</Th><Th>Date</Th><Th className="text-right">Amount</Th><Th className="text-right">GST</Th><Th className="text-right">Total</Th><Th>Status</Th><Th>Actions</Th>
        </tr></thead>
        <tbody>
          {filtered.map(inv => (
            <tr key={inv.no} className="hover:bg-muted/50">
              <Td className="font-mono text-[10px] font-semibold">{inv.no}</Td>
              <Td className="text-muted-fg text-[10px]">{inv.order}</Td>
              <Td className="font-semibold">{inv.dealer}</Td>
              <Td className="text-muted-fg">{inv.date}</Td>
              <Td className="text-right">{formatCurrency(inv.amount)}</Td>
              <Td className="text-right text-muted-fg">{formatCurrency(inv.gst)}</Td>
              <Td className="text-right font-bold">{formatCurrency(inv.total)}</Td>
              <Td><Badge variant={inv.status === "generated" ? "active" : "cancelled"}>{inv.status}</Badge></Td>
              <Td>
                <div className="flex gap-1">
                  <button className="p-1.5 rounded-md border border-border hover:bg-muted"><Eye className="h-3.5 w-3.5 text-muted-fg" /></button>
                  <button className="p-1.5 rounded-md border border-border hover:bg-muted"><Download className="h-3.5 w-3.5 text-muted-fg" /></button>
                  <button className="p-1.5 rounded-md border border-border hover:bg-muted"><Printer className="h-3.5 w-3.5 text-muted-fg" /></button>
                </div>
              </Td>
            </tr>
          ))}
        </tbody>
      </TableCard>
    </>
  );
}
