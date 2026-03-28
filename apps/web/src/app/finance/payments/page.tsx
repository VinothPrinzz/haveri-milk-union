"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { formatCurrency, cn } from "@/lib/utils";
import { PageHeader, StatCard, TableCard, Th, Td, Badge } from "@/components/ui";
import { Search } from "lucide-react";
const METHODS = ["All", "Wallet", "UPI", "Credit"];
export default function PaymentOverviewPage() {
  const [search, setSearch] = useState(""); const [methodFilter, setMethodFilter] = useState("All");
  const [dateFrom, setDateFrom] = useState(""); const [dateTo, setDateTo] = useState("");
  const { data } = useQuery({ queryKey: ["payments-overview", search, methodFilter, dateFrom, dateTo], queryFn: () => api.get("/api/v1/payments/overview", { search: search||undefined, method: methodFilter!=="All"?methodFilter.toLowerCase():undefined, dateFrom: dateFrom||undefined, dateTo: dateTo||undefined }) });
  const payments = data?.data ?? []; const summary = data?.summary ?? {};
  return (
    <>
      <PageHeader icon="💰" title="Payment Overview" subtitle="Payment collections and wallet balances" />
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-6">
        <StatCard icon="₹" iconBg="bg-success/10 text-success" value={formatCurrency(summary.totalCollected || 0)} label="Total Collected" />
        <StatCard icon="💳" iconBg="bg-brand-light text-brand" value={formatCurrency(summary.totalWalletBalance || 0)} label="Wallet Balance (All)" />
        <StatCard icon="📋" iconBg="bg-info/10 text-info" value={summary.totalTransactions ?? 0} label="Transactions" />
      </div>
      <div className="flex flex-wrap items-center gap-3 mb-5">
        <div className="flex items-center gap-2 bg-card border border-border rounded-lg px-3 py-2 w-56"><Search className="h-3.5 w-3.5 text-muted-fg" /><input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search dealer..." className="bg-transparent text-[11px] text-fg placeholder-muted-fg outline-none w-full font-medium" /></div>
        <div className="flex gap-2">{METHODS.map(m => (<button key={m} onClick={() => setMethodFilter(m)} className={cn("px-3 py-1.5 rounded-full text-[10px] font-bold border transition-colors", methodFilter===m?"bg-brand border-brand text-white":"bg-card border-border text-muted-fg")}>{m}</button>))}</div>
        <div className="flex items-center gap-1.5"><input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="h-8 bg-card border border-border rounded-lg px-2 text-[10px] font-medium outline-none" /><span className="text-[10px] text-muted-fg">to</span><input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="h-8 bg-card border border-border rounded-lg px-2 text-[10px] font-medium outline-none" /></div>
      </div>
      <TableCard>
        <thead><tr><Th>Dealer</Th><Th>Method</Th><Th className="text-right">Amount</Th><Th>Date</Th><Th>Status</Th></tr></thead>
        <tbody>{payments.map((p: any, i: number) => (<tr key={i} className="hover:bg-muted/50 cursor-pointer" onClick={() => window.open("/finance/invoices","_blank")}><Td className="font-semibold">{p.dealer_name}</Td><Td><Badge variant={p.payment_mode==="wallet"?"active":"pending"}>{p.payment_mode}</Badge></Td><Td className="text-right font-bold">{formatCurrency(p.grand_total)}</Td><Td className="text-muted-fg">{new Date(p.created_at).toLocaleDateString("en-IN")}</Td><Td><Badge variant={p.status==="cancelled"?"cancelled":"active"}>{p.status==="cancelled"?"failed":"paid"}</Badge></Td></tr>
        ))}{payments.length===0&&<tr><td colSpan={5} className="text-center py-8 text-muted-fg text-[12px]">No payments found</td></tr>}</tbody>
      </TableCard>
    </>
  );
}
