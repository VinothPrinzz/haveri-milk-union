"use client";
import { PageHeader, StatCard, TableCard, Th, Td, Badge, Button } from "@/components/ui";
import { formatCurrency, cn } from "@/lib/utils";
import { Search, Filter } from "lucide-react";
import { useState } from "react";

const PAYMENTS = [
  { dealer: "Raju Agencies", method: "wallet", amount: 933, date: "23 Jan 2025", status: "paid", invoiceNo: "INV-HMU-2025-0471" },
  { dealer: "Krishna Stores", method: "upi", amount: 1272, date: "22 Jan 2025", status: "paid", invoiceNo: "INV-HMU-2025-0290" },
  { dealer: "Laxmi Traders", method: "wallet", amount: 682, date: "21 Jan 2025", status: "paid", invoiceNo: "INV-HMU-2025-0250" },
  { dealer: "Ganesh Dairy", method: "credit", amount: 1038, date: "20 Jan 2025", status: "pending", invoiceNo: "INV-HMU-2025-0210" },
  { dealer: "Mahalakshmi Agency", method: "wallet", amount: 450, date: "19 Jan 2025", status: "paid", invoiceNo: "INV-HMU-2025-0185" },
  { dealer: "Raju Agencies", method: "upi", amount: 792, date: "18 Jan 2025", status: "paid", invoiceNo: "INV-HMU-2025-0344" },
];
const METHODS = ["All", "Wallet", "UPI", "Credit"];

export default function PaymentOverviewPage() {
  const [search, setSearch] = useState("");
  const [methodFilter, setMethodFilter] = useState("All");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  let filtered = PAYMENTS;
  if (search) filtered = filtered.filter(p => p.dealer.toLowerCase().includes(search.toLowerCase()));
  if (methodFilter !== "All") filtered = filtered.filter(p => p.method === methodFilter.toLowerCase());

  return (
    <>
      <PageHeader icon="💰" title="Payment Overview" subtitle="Payment collections and wallet balances" />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <StatCard icon="₹" iconBg="bg-success/10 text-success" value="₹4.8L" label="Total Collected" />
        <StatCard icon="💳" iconBg="bg-brand-light text-brand" value="₹1.2L" label="Wallet Balance (All)" />
        <StatCard icon="⚠️" iconBg="bg-warning/10 text-warning" value="₹32K" label="Outstanding Dues" />
        <StatCard icon="📈" iconBg="bg-success/10 text-success" value="₹84K" label="Today's Collection" />
      </div>
      <div className="flex flex-wrap items-center gap-3 mb-5">
        <div className="flex items-center gap-2 bg-card border border-border rounded-lg px-3 py-2 w-56"><Search className="h-3.5 w-3.5 text-muted-fg" /><input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search dealer..." className="bg-transparent text-[11px] text-fg placeholder-muted-fg outline-none w-full font-medium" /></div>
        <div className="flex gap-2">{METHODS.map(m => (<button key={m} onClick={() => setMethodFilter(m)} className={cn("px-3 py-1.5 rounded-full text-[10px] font-bold border transition-colors", methodFilter === m ? "bg-brand border-brand text-white" : "bg-card border-border text-muted-fg")}>{m}</button>))}</div>
        <div className="flex items-center gap-1.5"><input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="h-8 bg-card border border-border rounded-lg px-2 text-[10px] font-medium outline-none" /><span className="text-[10px] text-muted-fg">to</span><input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="h-8 bg-card border border-border rounded-lg px-2 text-[10px] font-medium outline-none" /></div>
      </div>
      <TableCard>
        <thead><tr><Th>Dealer</Th><Th>Method</Th><Th className="text-right">Amount</Th><Th>Date</Th><Th>Invoice</Th><Th>Status</Th></tr></thead>
        <tbody>{filtered.map((p, i) => (
          <tr key={i} className="hover:bg-muted/50 cursor-pointer" onClick={() => window.open(`/finance/invoices?inv=${p.invoiceNo}`, "_blank")}>
            <Td className="font-semibold">{p.dealer}</Td><Td><Badge variant={p.method==="wallet"?"active":p.method==="upi"?"badge-brand":"pending"}>{p.method}</Badge></Td><Td className="text-right font-bold">{formatCurrency(p.amount)}</Td><Td className="text-muted-fg">{p.date}</Td><Td className="font-mono text-[10px] text-brand hover:underline">{p.invoiceNo}</Td><Td><Badge variant={p.status}>{p.status}</Badge></Td></tr>
        ))}</tbody>
      </TableCard>
    </>
  );
}
