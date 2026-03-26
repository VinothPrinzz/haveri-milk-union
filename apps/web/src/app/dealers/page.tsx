"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { formatCurrency } from "@/lib/utils";
import { PageHeader, Badge, Button, TableCard, Th, Td, EmptyState } from "@/components/ui";
import { Plus, Search, Eye } from "lucide-react";

export default function DealersPage() {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  const { data, isLoading } = useQuery({
    queryKey: ["dealers", search, page],
    queryFn: () => api.get("/api/v1/dealers", { page, limit: 25, search: search || undefined }),
  });

  const dealers = data?.data ?? [];
  const total = data?.total ?? 0;
  const totalPages = data?.totalPages ?? 1;

  return (
    <>
      <PageHeader
        icon="👥"
        title="All Dealers"
        subtitle="Manage dealer accounts and wallet balances"
        actions={<Button size="sm"><Plus className="h-3.5 w-3.5" /> Add Dealer</Button>}
      />

      {/* Search */}
      <div className="mb-5">
        <div className="flex items-center gap-2 bg-card border border-border rounded-lg px-3 py-2 max-w-md">
          <Search className="h-4 w-4 text-muted-fg" />
          <input
            type="text"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            placeholder="Search dealers..."
            className="bg-transparent text-[12px] text-fg placeholder-muted-fg outline-none w-full font-medium"
          />
        </div>
      </div>

      <TableCard>
        <thead>
          <tr>
            <Th>Dealer</Th>
            <Th>Phone</Th>
            <Th>Location</Th>
            <Th className="text-right">Wallet Balance</Th>
            <Th>Status</Th>
            <Th>Actions</Th>
          </tr>
        </thead>
        <tbody>
          {dealers.map((d: any) => (
            <tr key={d.id} className="hover:bg-muted/50 transition-colors">
              <Td className="font-semibold">{d.name}</Td>
              <Td>{d.phone}</Td>
              <Td>
                <span className="text-[10px]">
                  {d.zone_slug === "haveri" ? "🏛️" : d.zone_slug === "ranebennur" ? "🌎" : "🏘️"}{" "}
                  {d.zone_name}
                </span>
              </Td>
              <Td className="text-right">
                <span className={`font-bold ${parseFloat(d.wallet_balance) === 0 ? "text-danger" : parseFloat(d.wallet_balance) < 5000 ? "text-warning" : "text-success"}`}>
                  {formatCurrency(d.wallet_balance)}
                </span>
              </Td>
              <Td><Badge variant={d.active ? "active" : "inactive"}>{d.active ? "active" : "inactive"}</Badge></Td>
              <Td>
                <button className="p-1.5 rounded-md border border-border hover:bg-muted transition-colors">
                  <Eye className="h-3.5 w-3.5 text-muted-fg" />
                </button>
              </Td>
            </tr>
          ))}
          {!isLoading && dealers.length === 0 && (
            <tr><td colSpan={6}><EmptyState message="No dealers found" /></td></tr>
          )}
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
