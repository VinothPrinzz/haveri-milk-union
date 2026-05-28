// apps/web/src/pages/finance/DealerStatementsPage.tsx
// Finance → Dealer Statements  (/finance/dealer-statements, finance.view)
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import PageHeader, {
  StatCard, EmptyState, fmtINR, fmtDate,
} from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Search, Printer, RefreshCw } from "lucide-react";
import {
  fetchDealerStatementIndex, fetchDealerStatement, printDealerStatement,
  type StatementIndexRow,
} from "@/services/api";

function monthStart() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}
function todayStr() { return new Date().toISOString().slice(0, 10); }
function drcr(n: number) { return n < 0 ? `${fmtINR(-n)} Dr` : `${fmtINR(n)} Cr`; }

export default function DealerStatementsPage() {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<StatementIndexRow | null>(null);
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(todayStr());

  const { data: index, isLoading: indexLoading } = useQuery({
    queryKey: ["statement-index", search],
    queryFn: () => fetchDealerStatementIndex({ search: search.trim() || undefined, limit: 100 }),
  });
  const dealers = index?.data ?? [];

  useEffect(() => {
    if (!selected && dealers.length) setSelected(dealers[0]);
  }, [dealers, selected]);

  const { data: stmt, isLoading: stmtLoading, refetch } = useQuery({
    queryKey: ["statement", selected?.id, from, to],
    queryFn: () => fetchDealerStatement(selected!.id, from, to),
    enabled: !!selected,
  });

  return (
    <div className="flex flex-col h-full">
      <PageHeader title="Dealer Statements" subtitle="Statement of account for any date range — print or share" />

      <div className="flex-1 flex overflow-hidden">
        {/* Left: dealer picker */}
        <div className="w-72 border-r border-border flex flex-col shrink-0">
          <div className="p-2 border-b border-border">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
              <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search dealer" className="erp-input pl-7 w-full" />
            </div>
          </div>
          <div className="flex-1 overflow-auto">
            {indexLoading ? (
              <div className="p-2 space-y-1">{Array.from({ length: 10 }).map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}</div>
            ) : dealers.map((d) => (
              <button key={d.id} onClick={() => setSelected(d)}
                className={`w-full text-left px-3 py-2 border-b border-border/50 hover:bg-muted/50 ${selected?.id === d.id ? "bg-muted" : ""}`}>
                <div className="text-[12.5px] font-medium truncate">{d.name}</div>
                <div className="flex justify-between text-[11px] text-muted-foreground">
                  <span className="font-mono">{d.code}</span>
                  <span>{drcr(d.closingBalance)}</span>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Right: statement viewer */}
        <div className="flex-1 overflow-auto p-4 space-y-4">
          {!selected ? (
            <EmptyState title="Pick a dealer to view a statement" />
          ) : (
            <>
              <div className="flex items-end gap-2 flex-wrap">
                <div>
                  <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">From</label>
                  <Input type="date" value={from} onChange={e => setFrom(e.target.value)} className="erp-input w-36" />
                </div>
                <div>
                  <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">To</label>
                  <Input type="date" value={to} onChange={e => setTo(e.target.value)} className="erp-input w-36" />
                </div>
                <Button variant="outline" size="sm" className="h-8" onClick={() => refetch()}><RefreshCw className="h-3.5 w-3.5 mr-1.5" />Refresh</Button>
                <Button variant="outline" size="sm" className="h-8" onClick={() => printDealerStatement(selected.id, from, to)}><Printer className="h-3.5 w-3.5 mr-1.5" />Print / PDF</Button>
              </div>

              <div className="text-[14px] font-semibold">{selected.name} <span className="text-muted-foreground font-mono text-[12px]">{selected.code}</span></div>

              <div className="grid grid-cols-3 gap-3">
                <StatCard label="Opening Balance" value={drcr(stmt?.openingBalance ?? 0)} />
                <StatCard label="Period Debit / Credit" value={`${fmtINR(stmt?.totals.debits ?? 0)} / ${fmtINR(stmt?.totals.credits ?? 0)}`} />
                <StatCard label="Closing Balance" tone={(stmt?.totals.closingBalance ?? 0) < 0 ? "danger" : "success"} value={drcr(stmt?.totals.closingBalance ?? 0)} />
              </div>

              <div className="erp-panel overflow-hidden">
                {stmtLoading ? (
                  <div className="p-4 space-y-2">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-7 w-full" />)}</div>
                ) : (
                  <table className="erp-table">
                    <thead>
                      <tr><th>Date</th><th>Voucher</th><th>Type</th><th>Particulars</th>
                        <th className="num" style={{ textAlign: "right" }}>Debit</th>
                        <th className="num" style={{ textAlign: "right" }}>Credit</th>
                        <th className="num" style={{ textAlign: "right" }}>Balance</th></tr>
                    </thead>
                    <tbody>
                      <tr className="bg-muted/30">
                        <td colSpan={6} className="font-medium">Opening Balance</td>
                        <td className="num" style={{ textAlign: "right" }}>{drcr(stmt?.openingBalance ?? 0)}</td>
                      </tr>
                      {(stmt?.rows ?? []).map((r) => (
                        <tr key={r.id}>
                          <td>{fmtDate(r.voucherDate)}</td>
                          <td className="font-mono text-[11px]">{r.voucherNo ?? "—"}</td>
                          <td className="text-[12px]">{r.voucherType ?? "—"}</td>
                          <td className="text-[12px]">{r.particulars ?? "—"}</td>
                          <td className="num" style={{ textAlign: "right" }}>{r.type === "debit" ? fmtINR(r.amount) : "—"}</td>
                          <td className="num" style={{ textAlign: "right" }}>{r.type === "credit" ? fmtINR(r.amount) : "—"}</td>
                          <td className="num" style={{ textAlign: "right" }}>{drcr(r.balanceAfter)}</td>
                        </tr>
                      ))}
                      {(stmt?.rows.length ?? 0) === 0 && (
                        <tr><td colSpan={7} className="text-center text-muted-foreground py-6">No transactions in this period</td></tr>
                      )}
                    </tbody>
                  </table>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
