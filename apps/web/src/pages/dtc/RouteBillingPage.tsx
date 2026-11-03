// apps/web/src/pages/dtc/RouteBillingPage.tsx
// ════════════════════════════════════════════════════════════════════
// DTC Billing → Route Billing Setup  (/dtc/setup/routes)
//
// Every route with the terms its contractor is paid on today. Opening a
// route goes to its record page (/dtc/setup/routes/:routeId), where the
// terms are changed, the rate history is kept and recent bills are shown.
// ════════════════════════════════════════════════════════════════════
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import PageHeader, { EmptyState, FilterBar } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertTriangle, ChevronRight, Search, Settings2 } from "lucide-react";
import { todayIST } from "@/lib/istDate";
import { fetchRouteTerms, type RouteTermsRow } from "@/services/dtc";
import { BILLING_TYPE_LABEL, FilterLabel, RATE_UNIT, fmtDMY, nice, rs2, useDtcPerms } from "./shared";

const daysUntil = (iso: string, today: string) => Math.round((Date.parse(iso) - Date.parse(today)) / 86400000);
type Filter = "all" | "billed" | "missing" | "expiring" | "verify";

export function routeFlags(r: RouteTermsRow, today: string) {
  const end = r.current?.contractEnd;
  return {
    missing: !r.current || !r.current.active,
    expiring: !!end && daysUntil(end, today) <= 30,
    verify: !!r.current?.notes?.startsWith("Imported"),
  };
}

export default function RouteBillingPage() {
  const perms = useDtcPerms();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const { data, isLoading } = useQuery({ queryKey: ["dtc-route-terms"], queryFn: fetchRouteTerms });
  const today = data?.today ?? todayIST();
  const rows = data?.data ?? [];

  const counts = useMemo(() => {
    const f = rows.map(r => routeFlags(r, today));
    return {
      billed: f.filter(x => !x.missing).length,
      missing: f.filter(x => x.missing).length,
      expiring: f.filter(x => x.expiring).length,
      verify: f.filter(x => x.verify).length,
    };
  }, [rows, today]);

  const shown = rows.filter(r => {
    const q = search.trim().toLowerCase();
    if (q && !`${r.routeCode} ${r.routeName} ${r.contractorName ?? ""} ${r.current?.vehicleNumber ?? ""}`.toLowerCase().includes(q)) return false;
    const f = routeFlags(r, today);
    if (filter === "billed") return !f.missing;
    if (filter !== "all" && !f[filter]) return false;
    return true;
  });

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Route Billing Setup"
        subtitle="How each route's transport contractor is paid: KM, Trip or Litre basis, rate, km per day and contract"
        actions={perms.setup && (
          <Button size="sm" variant="outline" className="h-8" asChild>
            <Link to="/dtc/setup/settings"><Settings2 className="h-3.5 w-3.5 mr-1.5" /> DTC Settings</Link>
          </Button>
        )}
      />
      <FilterBar>
        <div className="flex-1 min-w-[200px]">
          <FilterLabel>Search</FilterLabel>
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Route, contractor or vehicle" className="erp-input pl-7 w-full" />
          </div>
        </div>
        <div>
          <FilterLabel>Show</FilterLabel>
          <select value={filter} onChange={e => setFilter(e.target.value as Filter)} className="erp-input w-60">
            <option value="all">All routes ({rows.length})</option>
            <option value="billed">Billed ({counts.billed})</option>
            <option value="missing">Not set up / not billed ({counts.missing})</option>
            <option value="expiring">Contract ending in 30 days ({counts.expiring})</option>
            <option value="verify">Imported, to verify ({counts.verify})</option>
          </select>
        </div>
      </FilterBar>

      <div className="dtc-plain flex-1 overflow-auto p-4 sm:p-6 space-y-4">
        <p className="text-[14px]">
          <b>{counts.billed}</b> of {rows.length} routes are billed.
          {counts.missing > 0 && <> {counts.missing} not set up.</>}
          {counts.expiring > 0 && <span className="text-destructive"> {counts.expiring} contract{counts.expiring === 1 ? " ends" : "s end"} within 30 days.</span>}
          {counts.verify > 0 && <span className="text-warning"> {counts.verify} to check (copied from the old route master).</span>}
        </p>

        <div className="erp-panel overflow-auto">
          {isLoading ? (
            <div className="p-4 space-y-2">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-7 w-full" />)}</div>
          ) : shown.length === 0 ? (
            <EmptyState title="No routes match" />
          ) : (
            <table className="erp-table">
              <thead>
                <tr>
                  <th>Route</th><th>Contractor</th><th>Paid on</th><th className="text-right">Rate</th>
                  <th className="text-right">Km a day</th><th>Contract ends</th><th />
                </tr>
              </thead>
              <tbody>
                {shown.map(r => {
                  const c = r.current;
                  const f = routeFlags(r, today);
                  return (
                    <tr key={r.routeId} className="cursor-pointer" onClick={() => navigate(`/dtc/setup/routes/${r.routeId}`)}>
                      <td className="whitespace-nowrap"><span className="font-mono text-[11px] text-muted-foreground mr-1.5">{r.routeCode}</span>{r.routeName}</td>
                      <td>{r.contractorName ?? <span className="text-muted-foreground">No contractor</span>}</td>
                      {c && c.active ? (
                        <>
                          <td className="whitespace-nowrap">
                            {BILLING_TYPE_LABEL[c.billingType]}
                            {f.verify && <span className="ml-1.5 text-[11px] text-warning">check</span>}
                          </td>
                          <td className="text-right num whitespace-nowrap">₹{rs2(c.rate)} <span className="text-[11.5px] text-muted-foreground">{RATE_UNIT[c.billingType]}</span></td>
                          <td className="text-right num">{c.billingType === "km" ? nice(c.kmPerDay) : ""}</td>
                          <td className={`whitespace-nowrap ${f.expiring ? "text-destructive font-medium" : ""}`}>
                            {f.expiring && <AlertTriangle className="inline h-3.5 w-3.5 mr-1 -mt-0.5" />}
                            {c.contractEnd ? fmtDMY(c.contractEnd) : ""}
                          </td>
                        </>
                      ) : (
                        <td colSpan={4} className="text-muted-foreground text-[12.5px]">
                          {c && !c.active ? `Not billed from ${fmtDMY(c.effectiveFrom)}` : "Not set up: this route is not billed"}
                        </td>
                      )}
                      <td><ChevronRight className="h-4 w-4 text-muted-foreground" /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
