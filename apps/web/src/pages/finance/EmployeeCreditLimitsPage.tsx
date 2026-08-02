// apps/web/src/pages/finance/EmployeeCreditLimitsPage.tsx
// Finance → Employee Credit  (/finance/employee-credit-limits, finance.view/manage)
//
// The employee mirror of CreditLimitsPage. Two jobs:
//   1. Set employee credit limits (finance.manage — accountant / super_admin).
//   2. Release held indents — auto-placed employee indents that went over the
//      credit limit are parked as 'payment_required'; finance releases them
//      here (employees have no app / payment flow).
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import PageHeader, { FilterBar, StatCard, EmptyState, fmtINR } from "@/components/PageHeader";
import { F9SearchSelect, type F9Option } from "@/components/F9SearchSelect";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Search, Pencil, Check, X, ShieldAlert, Wallet, BadgeIndianRupee, Hourglass } from "lucide-react";
import {
  fetchEmployeeCreditControl, fetchEmployeeCreditSummary, fetchRoutes,
  updateEmployeeCreditLimit, fetchHeldEmployeeOrders, releaseEmployeeOrder,
  type EmployeeCreditRow,
} from "@/services/api";

const CAN_EDIT = new Set(["accountant", "super_admin", "call_desk"]);

export default function EmployeeCreditLimitsPage() {
  const { user } = useAuth();
  const canEdit = CAN_EDIT.has(user?.role ?? "");
  const queryClient = useQueryClient();

  const [search, setSearch] = useState("");
  const [routeId, setRouteId] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  useEffect(() => { setPage(1); }, [search, routeId]);

  const { data: routes = [] } = useQuery({ queryKey: ["routes"], queryFn: fetchRoutes });
  const routeOptions: F9Option[] = useMemo(
    () => (routes as any[]).map((r) => ({ value: String(r.id), label: r.name, sublabel: r.code })),
    [routes]
  );

  const filters = { search: search.trim() || undefined, routeId: routeId ?? undefined };
  const { data, isLoading } = useQuery({
    queryKey: ["employee-credit-limits", filters, page],
    queryFn: () => fetchEmployeeCreditControl({ ...filters, page, limit: 50 }),
  });
  const { data: summary } = useQuery({
    queryKey: ["employee-credit-summary"],
    queryFn: fetchEmployeeCreditSummary,
  });
  const { data: held = [] } = useQuery({
    queryKey: ["employee-held-orders"],
    queryFn: fetchHeldEmployeeOrders,
  });

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ["employee-credit-limits"] });
    queryClient.invalidateQueries({ queryKey: ["employee-credit-summary"] });
    queryClient.invalidateQueries({ queryKey: ["employee-held-orders"] });
  };

  const saveLimit = useMutation({
    mutationFn: ({ id, value }: { id: string; value: number }) => updateEmployeeCreditLimit(id, value),
    onSuccess: () => {
      toast.success("Credit limit updated");
      setEditingId(null);
      invalidateAll();
    },
    onError: (e: any) => toast.error(e?.message ?? "Failed to update credit limit"),
  });

  const release = useMutation({
    mutationFn: (orderId: string) => releaseEmployeeOrder(orderId),
    onSuccess: () => { toast.success("Indent released & placed"); invalidateAll(); },
    onError: (e: any) => toast.error(e?.message ?? "Failed to release indent"),
  });

  const startEdit = (d: EmployeeCreditRow) => {
    setEditingId(d.id);
    setEditValue(String(d.creditLimit ?? 0));
  };
  const commit = (id: string) => saveLimit.mutate({ id, value: Number(editValue) || 0 });

  const rows: EmployeeCreditRow[] = data?.data ?? [];
  const totalPages = data?.totalPages ?? 1;

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Employee Credit"
        subtitle="Set employee credit limits and release held indents — finance only."
      />

      <FilterBar>
        <div className="flex-1 min-w-[200px]">
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">Search</label>
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Employee name / code" className="erp-input pl-7 w-full" />
          </div>
        </div>
        <div>
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">Route</label>
          <F9SearchSelect value={routeId} onChange={setRouteId} options={routeOptions} placeholder="All" />
        </div>
      </FilterBar>

      <div className="flex-1 overflow-auto p-4 space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard label="Total Limit Sanctioned" tone="default" value={fmtINR(summary?.totalLimitSanctioned ?? 0)} icon={<BadgeIndianRupee className="h-5 w-5" />} />
          <StatCard label="Total Available" tone="success" value={fmtINR(summary?.totalAvailable ?? 0)} icon={<Wallet className="h-5 w-5" />} />
          <StatCard label="Over Limit" tone={(summary?.overLimitCount ?? 0) > 0 ? "danger" : "default"} value={summary?.overLimitCount ?? 0} hint="employees" icon={<ShieldAlert className="h-5 w-5" />} />
          <StatCard label="Held Indents" tone={(summary?.heldCount ?? 0) > 0 ? "warning" : "default"} value={summary?.heldCount ?? 0} hint="awaiting release" icon={<Hourglass className="h-5 w-5" />} />
        </div>

        {!canEdit && (
          <div className="rounded-sm border border-warning/40 bg-warning/10 px-3 py-2 text-[12px] text-warning">
            You have read-only access. Only Finance (accountant) users can change credit limits or release held indents.
          </div>
        )}

        {/* ── Held indents worklist ── */}
        {held.length > 0 && (
          <div className="erp-panel overflow-hidden">
            <div className="px-4 py-2.5 border-b border-border bg-warning/10 flex items-center gap-2">
              <Hourglass className="h-4 w-4 text-warning" />
              <h3 className="font-semibold text-[14px]">Held Indents — over credit limit</h3>
            </div>
            <table className="erp-table">
              <thead>
                <tr>
                  <th>Code</th><th>Employee</th><th>Delivery</th>
                  <th className="num" style={{ textAlign: "right" }}>Items</th>
                  <th className="num" style={{ textAlign: "right" }}>Amount</th>
                  {canEdit && <th style={{ width: 110 }}></th>}
                </tr>
              </thead>
              <tbody>
                {held.map((o) => (
                  <tr key={o.id}>
                    <td className="font-mono text-[11px]">{o.employeeCode ?? "—"}</td>
                    <td className="font-medium">{o.employeeName}</td>
                    <td className="text-[12px]">{o.deliveryDate}</td>
                    <td className="num" style={{ textAlign: "right" }}>{o.itemCount}</td>
                    <td className="num" style={{ textAlign: "right" }}>{fmtINR(o.grandTotal)}</td>
                    {canEdit && (
                      <td>
                        <Button
                          size="sm" variant="outline" className="h-6"
                          disabled={release.isPending}
                          onClick={() => release.mutate(o.id)}
                        >
                          Release
                        </Button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* ── Credit limits table ── */}
        <div className="erp-panel overflow-hidden">
          {isLoading ? (
            <div className="p-4 space-y-2">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-7 w-full" />)}</div>
          ) : rows.length === 0 ? (
            <EmptyState title="No employees match your filter" />
          ) : (
            <table className="erp-table">
              <thead>
                <tr>
                  <th>Code</th><th>Name</th><th>Route</th>
                  <th className="num" style={{ textAlign: "right" }}>Outstanding</th>
                  <th className="num" style={{ textAlign: "right" }}>Available</th>
                  <th className="num" style={{ textAlign: "right" }}>Credit Limit</th>
                  {canEdit && <th style={{ width: 80 }}></th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => {
                  const editing = editingId === d.id;
                  return (
                    <tr key={d.id}>
                      <td className="font-mono text-[11px]">{d.code ?? "—"}</td>
                      <td className="font-medium">{d.name}</td>
                      <td className="text-[12px]">{d.route_name ?? "—"}</td>
                      <td className="num text-destructive" style={{ textAlign: "right" }}>{d.outstanding > 0 ? fmtINR(d.outstanding) : "—"}</td>
                      <td className="num" style={{ textAlign: "right" }}>{fmtINR(d.availableCredit)}</td>
                      <td className="num" style={{ textAlign: "right" }}>
                        {editing ? (
                          <Input
                            autoFocus type="number" min={0} value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") commit(d.id);
                              if (e.key === "Escape") setEditingId(null);
                            }}
                            className="erp-input h-6 w-28 text-right ml-auto"
                          />
                        ) : (
                          <span className={d.creditLimit > 0 ? "" : "text-muted-foreground"}>{fmtINR(d.creditLimit)}</span>
                        )}
                      </td>
                      {canEdit && (
                        <td>
                          {editing ? (
                            <div className="flex items-center gap-1">
                              <button title="Save" disabled={saveLimit.isPending} onClick={() => commit(d.id)} className="p-1 text-success hover:bg-success/10 rounded-sm disabled:opacity-50">
                                <Check className="h-3.5 w-3.5" />
                              </button>
                              <button title="Cancel" onClick={() => setEditingId(null)} className="p-1 text-muted-foreground hover:bg-muted rounded-sm">
                                <X className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          ) : (
                            <button title="Edit credit limit" onClick={() => startEdit(d)} className="p-1 text-muted-foreground hover:text-foreground hover:bg-accent rounded-sm">
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-2 border-t border-border bg-muted/30 text-[12px]">
              <span className="text-muted-foreground">Page {page} of {totalPages} · {data?.total ?? 0} employees</span>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" className="h-7" disabled={page <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}>Previous</Button>
                <Button variant="outline" size="sm" className="h-7" disabled={page >= totalPages} onClick={() => setPage(p => Math.min(totalPages, p + 1))}>Next</Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
