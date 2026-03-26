"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { formatCurrency, formatDate, cn } from "@/lib/utils";
import { PageHeader, Badge, Button, TableCard, Th, Td, EmptyState } from "@/components/ui";
import { Eye, Search, Filter } from "lucide-react";
import Link from "next/link";

const STATUS_FILTERS = ["All", "Pending", "Confirmed", "Dispatched", "Delivered", "Cancelled"];

export default function OrdersPage() {
  const [statusFilter, setStatusFilter] = useState("All");
  const [search, setSearch] = useState("");
  const [dealerFilter, setDealerFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(1);

  const { data, isLoading } = useQuery({
    queryKey: ["orders", statusFilter, page],
    queryFn: () => api.get("/api/v1/orders", { page, limit: 25, ...(statusFilter !== "All" ? { status: statusFilter.toLowerCase() } : {}) }),
  });

  let orders = data?.data ?? [];
  if (search) orders = orders.filter((o: any) => o.id.includes(search));
  if (dealerFilter) orders = orders.filter((o: any) => o.dealer_name?.toLowerCase().includes(dealerFilter.toLowerCase()));
  const total = data?.total ?? 0;
  const totalPages = data?.totalPages ?? 1;

  return (
    <>
      <PageHeader icon="📋" title="All Indents" subtitle="Manage and track all dealer indents" />

      {/* Filters Row */}
      <div className="flex flex-wrap items-center gap-3 mb-5">
        {/* Search by ID */}
        <div className="flex items-center gap-2 bg-card border border-border rounded-lg px-3 py-2 w-56">
          <Search className="h-3.5 w-3.5 text-muted-fg" />
          <input type="text" value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} placeholder="Search by Indent ID..."
            className="bg-transparent text-[11px] text-fg placeholder-muted-fg outline-none w-full font-medium" />
        </div>
        {/* Dealer filter */}
        <div className="flex items-center gap-2 bg-card border border-border rounded-lg px-3 py-2 w-48">
          <Filter className="h-3.5 w-3.5 text-muted-fg" />
          <input type="text" value={dealerFilter} onChange={e => { setDealerFilter(e.target.value); setPage(1); }} placeholder="Filter by dealer..."
            className="bg-transparent text-[11px] text-fg placeholder-muted-fg outline-none w-full font-medium" />
        </div>
        {/* Date range */}
        <div className="flex items-center gap-1.5">
          <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
            className="h-8 bg-card border border-border rounded-lg px-2 text-[10px] font-medium outline-none" />
          <span className="text-[10px] text-muted-fg">to</span>
          <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
            className="h-8 bg-card border border-border rounded-lg px-2 text-[10px] font-medium outline-none" />
        </div>
      </div>

      {/* Status Tabs */}
      <div className="flex gap-2 mb-5 flex-wrap">
        {STATUS_FILTERS.map(f => (
          <button key={f} onClick={() => { setStatusFilter(f); setPage(1); }}
            className={cn("px-3 py-1.5 rounded-full text-[10px] font-bold border transition-colors",
              statusFilter === f ? "bg-brand border-brand text-white" : "bg-card border-border text-muted-fg hover:border-brand/30")}>{f}</button>
        ))}
      </div>

      <TableCard>
        <thead><tr><Th>Order ID</Th><Th>Dealer</Th><Th>Zone</Th><Th>Items</Th><Th className="text-right">Amount</Th><Th>Status</Th><Th>Payment</Th><Th>Date</Th><Th>Actions</Th></tr></thead>
        <tbody>
          {orders.map((o: any) => (
            <tr key={o.id} className="hover:bg-muted/50"><Td className="font-display text-[10px] font-bold">#{o.id.slice(0,8)}</Td><Td className="font-semibold">{o.dealer_name}</Td><Td>{o.zone_name}</Td><Td>{o.item_count}</Td><Td className="text-right font-bold">{formatCurrency(o.grand_total)}</Td><Td><Badge variant={o.status}>{o.status}</Badge></Td><Td><Badge variant={o.payment_mode==="wallet"?"active":"pending"}>{o.payment_mode}</Badge></Td><Td className="text-muted-fg">{formatDate(o.created_at)}</Td>
              <Td><Link href={`/orders/${o.id}`}><button className="p-1.5 rounded-md border border-border hover:bg-muted"><Eye className="h-3.5 w-3.5 text-muted-fg" /></button></Link></Td></tr>
          ))}
          {!isLoading && orders.length === 0 && <tr><td colSpan={9}><EmptyState message="No orders found" /></td></tr>}
        </tbody>
      </TableCard>

      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4">
          <p className="text-[11px] text-muted-fg">Showing {(page-1)*25+1}–{Math.min(page*25,total)} of {total}</p>
          <div className="flex gap-1.5">
            <Button variant="outline" size="sm" disabled={page<=1} onClick={()=>setPage(page-1)}>Previous</Button>
            <Button variant="outline" size="sm" disabled={page>=totalPages} onClick={()=>setPage(page+1)}>Next</Button>
          </div>
        </div>
      )}
    </>
  );
}
