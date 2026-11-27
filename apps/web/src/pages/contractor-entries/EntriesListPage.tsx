// apps/web/src/pages/contractor-entries/EntriesListPage.tsx
// Contractor Entries → My contractor entries  (/contractor-entries)
// A route officer's entries against the transport contractors of their
// routes, a month at a time, with what each adds to or takes off the bill.
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Plus, Search } from "lucide-react";
import { EmptyState, FilterBar } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { todayIST } from "@/lib/istDate";
import { fetchEntryLookups, fetchOfficerEntries, type EntryType } from "@/services/officerEntries";
import { FilterLabel, MonthInput, fmtDMY, monthLabel } from "@/pages/dtc/shared";
import { RecordHeader } from "@/pages/dtc/ui";
import { EntryStatusPill, TYPE_LABEL, money, signedMoney, useCanRecordEntries } from "./shared";

export default function EntriesListPage() {
  const navigate = useNavigate();
  const canRecord = useCanRecordEntries();
  const thisMonth = todayIST().slice(0, 7);
  const [month, setMonth] = useState(thisMonth);
  const [routeId, setRouteId] = useState("");
  const [type, setType] = useState<EntryType | "">("");
  const [q, setQ] = useState("");

  const { data: lookups } = useQuery({ queryKey: ["officer-entry-lookups", todayIST()], queryFn: () => fetchEntryLookups(todayIST()) });
  const { data, isLoading } = useQuery({
    queryKey: ["officer-entries", month, routeId, type, q],
    queryFn: () => fetchOfficerEntries({ month, routeId, type, q }),
  });
  const rows = data?.data ?? [];
  const t = data?.totals;
  const routes = useMemo(() => lookups?.routes ?? [], [lookups]);

  return (
    <div className="h-full overflow-auto">
      <RecordHeader
        title="My contractor entries"
        subtitle={monthLabel(month)}
        actions={canRecord && (
          <Button size="sm" className="h-8" onClick={() => navigate("/contractor-entries/new")}>
            <Plus className="h-3.5 w-3.5 mr-1.5" /> New entry
          </Button>
        )}
        facts={[
          { label: "Entries this month", value: t?.count ?? "—" },
          { label: "Deductions", value: t ? money(t.deductions) : "—", tone: "danger" },
          { label: "Additions", value: t ? money(t.additions) : "—", tone: "success" },
          { label: "Not yet on a bill", value: t?.notOnBill ?? "—", tone: t?.notOnBill ? "warning" : "default" },
        ]}
      />
      <FilterBar>
        <div>
          <FilterLabel>Month</FilterLabel>
          <MonthInput value={month} onChange={setMonth} max={thisMonth} className="w-40" />
        </div>
        <div>
          <FilterLabel>Route</FilterLabel>
          <select value={routeId} onChange={e => setRouteId(e.target.value)} className="erp-input h-8 w-56 max-w-full">
            <option value="">All my routes</option>
            {routes.map(r => <option key={r.id} value={r.id}>{r.code} · {r.name}</option>)}
          </select>
        </div>
        <div>
          <FilterLabel>Type</FilterLabel>
          <select value={type} onChange={e => setType(e.target.value as EntryType | "")} className="erp-input h-8 w-44">
            <option value="">All types</option>
            {(Object.keys(TYPE_LABEL) as EntryType[]).map(k => <option key={k} value={k}>{TYPE_LABEL[k]}</option>)}
          </select>
        </div>
        <div className="flex-1 min-w-[180px]">
          <FilterLabel>Search</FilterLabel>
          <div className="relative">
            <Search className="h-3.5 w-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input value={q} onChange={e => setQ(e.target.value)} placeholder="Customer, contractor, product…" className="erp-input h-8 pl-7" />
          </div>
        </div>
      </FilterBar>

      <div className="p-3 sm:p-5">
        {isLoading ? (
          <div className="space-y-2">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-9 w-full" />)}</div>
        ) : rows.length === 0 ? (
          <EmptyState title="No entries" hint={`Nothing recorded for ${monthLabel(month)}${type || routeId || q ? " with these filters" : ""}.`} />
        ) : (
          <div className="erp-panel overflow-x-auto">
            <table className="erp-table text-[13px] min-w-[760px]">
              <thead>
                <tr>
                  <th style={{ width: 96 }}>Date</th>
                  <th>Route and contractor</th>
                  <th style={{ width: 130 }}>Type</th>
                  <th>Detail</th>
                  <th className="text-right" style={{ width: 130 }}>Amount</th>
                  <th style={{ width: 140 }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(e => (
                  <tr key={e.id} className="cursor-pointer hover:bg-muted/40" onClick={() => navigate(`/contractor-entries/${e.id}`)}>
                    <td className="whitespace-nowrap">
                      {fmtDMY(e.entryDate)}
                      {e.shift === "evening" && <div className="text-[11px] text-muted-foreground">Evening</div>}
                    </td>
                    <td>
                      <div><span className="font-mono text-[12px] text-muted-foreground mr-1">{e.routeCode}</span>{e.routeName}</div>
                      <div className="text-[12px] text-muted-foreground">{e.contractorName ?? "No contractor"}</div>
                    </td>
                    <td className="whitespace-nowrap">{TYPE_LABEL[e.type]}</td>
                    <td className="text-[12.5px]">{e.detail}</td>
                    <td className={cn("text-right num font-medium whitespace-nowrap",
                      e.status === "removed" ? "text-muted-foreground line-through" : e.kind === "deduction" ? "text-destructive" : "text-success")}>
                      {signedMoney(e.kind, e.amount)}
                    </td>
                    <td><EntryStatusPill status={e.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
