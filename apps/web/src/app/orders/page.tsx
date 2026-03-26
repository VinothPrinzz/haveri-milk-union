"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { formatCurrency, formatDate } from "@/lib/utils";
import { PageHeader, Badge, Button, TableCard, Th, Td, EmptyState } from "@/components/ui";
import { cn } from "@/lib/utils";
import { Download, Eye } from "lucide-react";
import Link from "next/link";

const STATUS_FILTERS = ["All", "Pending", "Confirmed", "Dispatched", "Delivered", "Cancelled"];

export default function OrdersPage() {
  const [statusFilter, setStatusFilter] = useState("All");
  const [page, setPage] = useState(1);

  const { data, isLoading } = useQuery({
    queryKey: ["orders", statusFilter, page],
    queryFn: () =>
      api.get("/api/v1/orders", {
        page,
        limit: 25,
        ...(statusFilter !== "All" ? { status: statusFilter.toLowerCase() } : {}),
      }),
  });

  const orders = data?.data ?? [];
  const total = data?.total ?? 0;
  const totalPages = data?.totalPages ?? 1;

  return (
    <>
      <PageHeader
        icon="📋"
        title="All Indents"
        subtitle="Manage and track all dealer indents"
        actions={<Button variant="outline" size="sm"><Download className="h-3.5 w-3.5" /> Export</Button>}
      />

      {/* Status Filter Tabs */}
      <div className="flex gap-2 mb-5 flex-wrap">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => { setStatusFilter(f); setPage(1); }}
            className={cn(
              "px-3 py-1.5 rounded-full text-[10px] font-bold border transition-colors",
              statusFilter === f
                ? "bg-brand border-brand text-white"
                : "bg-card border-border text-muted-fg hover:border-brand/30"
            )}
          >
            {f}
          </button>
        ))}
      </div>

      {/* Orders Table */}
      <TableCard>
        <thead>
          <tr>
            <Th>Order ID</Th>
            <Th>Dealer</Th>
            <Th>Zone</Th>
            <Th>Items</Th>
            <Th className="text-right">Amount</Th>
            <Th>Status</Th>
            <Th>Payment</Th>
            <Th>Date</Th>
            <Th>Actions</Th>
          </tr>
        </thead>
        <tbody>
          {orders.map((o: any) => (
            <tr key={o.id} className="hover:bg-muted/50 transition-colors">
              <Td className="font-display text-[10px] font-bold">#{o.id.slice(0, 8)}</Td>
              <Td className="font-semibold">{o.dealer_name}</Td>
              <Td>{o.zone_name}</Td>
              <Td>{o.item_count}</Td>
              <Td className="text-right font-bold">{formatCurrency(o.grand_total)}</Td>
              <Td><Badge variant={o.status}>{o.status}</Badge></Td>
              <Td><Badge variant={o.payment_mode === "wallet" ? "active" : "pending"}>{o.payment_mode}</Badge></Td>
              <Td className="text-muted-fg">{formatDate(o.created_at)}</Td>
              <Td>
                <Link href={`/orders/${o.id}`}>
                  <button className="p-1.5 rounded-md border border-border hover:bg-muted transition-colors">
                    <Eye className="h-3.5 w-3.5 text-muted-fg" />
                  </button>
                </Link>
              </Td>
            </tr>
          ))}
          {!isLoading && orders.length === 0 && (
            <tr><td colSpan={9}><EmptyState message="No orders found" /></td></tr>
          )}
        </tbody>
      </TableCard>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4">
          <p className="text-[11px] text-muted-fg">
            Showing {(page - 1) * 25 + 1}–{Math.min(page * 25, total)} of {total}
          </p>
          <div className="flex gap-1.5">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              Previous
            </Button>
            <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>
              Next
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
