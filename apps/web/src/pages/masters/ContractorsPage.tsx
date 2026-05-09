// ════════════════════════════════════════════════════════════════════
// All Contractors / New Contractor — ERP refactor
// Routes preserved: /masters/contractors + /masters/contractors/new
// All mutations and ContractorForm wiring identical to v1.4 source.
// ════════════════════════════════════════════════════════════════════
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import PageHeader, {
  FilterBar,
  Field,
  StatusPill,
  EmptyState,
  fmtDate,
} from "@/components/PageHeader";
import { F9SearchSelect, type F9Option } from "@/components/F9SearchSelect";
import type { Column } from "@/components/DataTable";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { X, Plus } from "lucide-react";
import {
  fetchContractors,
  fetchRoutes,
  createContractor,
  updateContractor,
  type Contractor,
} from "@/services/api";
import { ContractorForm } from "@/components/contractors/ContractorForm";
import type { ContractorFormData } from "@/lib/validations";

interface Props {
  tab?: "list" | "new";
}

const STATUS_OPTIONS: F9Option[] = [
  { value: "Active", label: "Active" },
  { value: "Inactive", label: "Inactive" },
];

export default function ContractorsPage({ tab = "list" }: Props) {
  const qc = useQueryClient();
  const { data: contractors = [], isLoading } = useQuery({
    queryKey: ["contractors"],
    queryFn: fetchContractors,
  });

  const { data: routes = [] } = useQuery({ queryKey: ["routes"], queryFn: fetchRoutes });
  const routeMap = useMemo(() => {
    const m = new Map<string, { code: string; name: string }>();
    routes.forEach((r: any) => m.set(r.id, { code: r.code, name: r.name }));
    return m;
  }, [routes]);
  
  const [viewing, setViewing] = useState<Contractor | null>(null);
  const [editing, setEditing] = useState<Contractor | null>(null);

  const cols: Column<Contractor>[] = [
    { key: "code", header: "Code", cell: c => <span className="font-mono text-[12px]">{c.code}</span>, width: "90px" },
    { key: "name", header: "Name", cell: c => <span className="font-medium">{c.name}</span> },
    { key: "phone", header: "Phone", cell: c => c.phone, width: "120px" },
    { key: "vehicle", header: "Vehicle", cell: c => c.vehicleNumber ?? "—", width: "110px" },
    {
      key: "routes",
      header: "Routes",
      cell: c => {
        const ids: string[] = (c as any).routeIds ?? [];
        if (ids.length === 0) return <span className="text-muted-foreground">—</span>;
        return (
          <div className="flex flex-col gap-0.5">
            {ids.map(id => {
              const r = routeMap.get(id);
              return (
                <span key={id} className="text-[12px]">
                  <span className="font-mono">{r?.code ?? id.slice(0, 6)}</span>
                  {r?.name && <> — {r.name}</>}
                </span>
              );
            })}
          </div>
        );
      },
    },
    {
      key: "actions",
      header: "Actions",
      align: "right",
      width: "180px",
      cell: c => (
        <div className="flex items-center justify-end gap-1.5">
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2.5 text-[12px]"
            onClick={() => setViewing(c)}
          >
            View
          </Button>
          <Button
            size="sm"
            className="h-7 px-2.5 text-[12px]"
            onClick={() => setEditing(c)}
          >
            Update
          </Button>
        </div>
      ),
    },
  ];

  const createMutation = useMutation({
    mutationFn: createContractor,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contractors"] });
      qc.invalidateQueries({ queryKey: ["routes"] });
      toast.success("Contractor created");
    },
    onError: (e: any) => toast.error(e?.message || "Failed to create contractor"),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: ContractorFormData }) =>
      updateContractor(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contractors"] });
      qc.invalidateQueries({ queryKey: ["routes"] });
      toast.success("Contractor updated");
    },
    onError: (e: any) => toast.error(e?.message || "Failed to update contractor"),
  });

  if (tab === "new") {
    return (
      <div>
        <PageHeader title="New Contractor" subtitle="Add a new contractor" />
        <div className="p-4">
          <div className="erp-panel p-4">
            <ContractorForm
              onSubmit={async data => {
                await createMutation.mutateAsync(data as any);
              }}
              isSubmitting={createMutation.isPending}
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <ContractorListTab
      contractors={contractors}
      routes={routes}
      isLoading={isLoading}
      updateMutation={updateMutation}
    />
  );
}

function ContractorListTab({
  contractors,
  routes,
  isLoading,
  updateMutation,
}: {
  contractors: Contractor[];
  routes: any[];
  isLoading: boolean;
  updateMutation: any;
}) {
  const [nameFilter, setNameFilter] = useState<string | null>(null);
  const [routeFilter, setRouteFilter] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [generated, setGenerated] = useState(false);
  const [editing, setEditing] = useState<Contractor | null>(null);
  const [viewing, setViewing] = useState<Contractor | null>(null);

  const routeMap = useMemo(() => {
    const m = new Map<string, { code: string; name: string }>();
    routes.forEach((r: any) => m.set(r.id, { code: r.code, name: r.name }));
    return m;
  }, [routes]);

  const nameOptions: F9Option[] = useMemo(
    () => contractors.map(c => ({ value: c.id, label: c.name, sublabel: c.code })),
    [contractors]
  );
  const routeOptions: F9Option[] = useMemo(
    () => routes.map((r: any) => ({ value: r.id, label: r.name, sublabel: r.code })),
    [routes]
  );

  const filtered = useMemo(() => {
    if (!generated) return [];
    return contractors.filter(c => {
      if (nameFilter && c.id !== nameFilter) return false;
      if (statusFilter && c.status !== statusFilter) return false;
      if (routeFilter && !(c.routeIds ?? []).includes(routeFilter)) return false;
      return true;
    });
  }, [contractors, nameFilter, routeFilter, statusFilter, generated]);

  const clearFilters = () => {
    setNameFilter(null);
    setRouteFilter(null);
    setStatusFilter(null);
    setGenerated(false);
  };

  const routeCodeById = useMemo(() => {
    const m = new Map<string, string>();
    routes.forEach((r: any) => m.set(r.id, r.code));
    return m;
  }, [routes]);

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="All Contractors"
        subtitle="View and manage contractors"
        actions={
          <Button asChild size="sm" className="h-8">
            <a href="/masters/contractors/new"><Plus className="h-3.5 w-3.5 mr-1" /> New</a>
          </Button>
        }
      />
      
      <FilterBar>
        <Field label="Name">
          <F9SearchSelect value={nameFilter} onChange={setNameFilter} options={nameOptions} allowAll className="w-64" />
        </Field>
        <Field label="Assigned Route">
          <F9SearchSelect value={routeFilter} onChange={setRouteFilter} options={routeOptions} allowAll className="w-56" />
        </Field>
        <Field label="Status">
          <F9SearchSelect value={statusFilter} onChange={setStatusFilter} options={STATUS_OPTIONS} allowAll className="w-40" />
        </Field>
        <div className="flex items-end gap-2">
          <Button size="sm" className="h-8" onClick={() => setGenerated(true)}>Generate</Button>
          {generated && (
            <Button size="sm" variant="outline" className="h-8" onClick={clearFilters}>
              <X className="h-3.5 w-3.5 mr-1" /> Clear
            </Button>
          )}
        </div>
      </FilterBar>

      <div className="flex-1 overflow-auto p-3">
        <div className="erp-panel overflow-hidden">
          {!generated ? (
            <EmptyState
              title="Set filters and click Generate"
              hint="Or leave all filters as ‘All’ to list every contractor."
            />
          ) : isLoading ? (
            <div className="p-4 space-y-2">
              {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-7 w-full" />)}
            </div>
          ) : (
            <table className="erp-table">
              <thead>
                <tr>
                  <th style={{ width: 90 }}>Code</th>
                  <th>Name</th>
                  <th style={{ width: 120 }}>Phone</th>
                  <th style={{ width: 110 }}>Vehicle</th>
                  <th>Routes</th>
                  <th style={{ width: 110 }}>Period From</th>
                  <th style={{ width: 110 }}>Period To</th>
                  <th style={{ width: 90 }}>Status</th>
                  <th style={{ width: 180, textAlign: "right" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(c => (
                  <tr key={c.id}>
                    <td className="font-mono">{c.code}</td>
                    <td className="font-medium">{c.name}</td>
                    <td className="font-mono text-[12.5px]">{c.phone}</td>
                    <td className="font-mono text-[12.5px]">{c.vehicleNumber || "—"}</td>
                    <td>
                      {(c.routeIds ?? []).length > 0 ? (
                        <div className="flex flex-col gap-0.5">
                          {(c.routeIds ?? []).map(rid => {
                            const r = routeMap.get(rid);
                            return (
                              <span key={rid} className="text-[12px]">
                                <span className="font-mono">{r?.code ?? "?"}</span>
                                {r?.name ? ` — ${r.name}` : ""}
                              </span>
                            );
                          })}
                        </div>
                      ) : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="text-[12.5px]">{fmtDate(c.periodFrom)}</td>
                    <td className="text-[12.5px]">{fmtDate(c.periodTo)}</td>
                    <td><StatusPill status={c.status === "Active" ? "active" : "draft"} /></td>
                    <td style={{ textAlign: "right" }}>
                      <div className="flex items-center justify-end gap-1.5">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 px-2.5 text-[12px]"
                          onClick={() => setViewing(c)}
                        >
                          View
                        </Button>
                        <Button
                          size="sm"
                          className="h-7 px-2.5 text-[12px]"
                          onClick={() => setEditing(c)}
                        >
                          Update
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr><td colSpan={9} className="py-8 text-center text-muted-foreground">No contractors match the selected filters.</td></tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Edit Dialog */}
      {editing && (
        <Dialog open onOpenChange={o => !o && setEditing(null)}>
          <DialogContent className="max-w-3xl max-h-[90vh] overflow-auto">
            <DialogHeader>
              <DialogTitle>Edit Contractor — {editing.code}</DialogTitle>
            </DialogHeader>
            <ContractorForm
              initialData={editing as any}
              isSubmitting={updateMutation.isPending}
              onSubmit={async data => {
                await updateMutation.mutateAsync({ id: editing.id, data });
                setEditing(null);
              }}
            />
          </DialogContent>
        </Dialog>
      )}

      {/* View Dialog */}
      <Dialog open={!!viewing} onOpenChange={o => !o && setViewing(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>{viewing?.code} — {viewing?.name}</DialogTitle></DialogHeader>
          {viewing && (() => {
            const Row = ({ label, value }: { label: string; value: any }) => (
              <div className="flex items-baseline gap-2 py-1 border-b border-border/60 last:border-0">
                <span className="text-[11px] uppercase tracking-wide text-muted-foreground w-32 shrink-0">{label}</span>
                <span className="text-[13px] font-medium">{value || <span className="text-muted-foreground">—</span>}</span>
              </div>
            );
            return (
              <div className="grid grid-cols-2 gap-x-6">
                <Row label="Code" value={<span className="font-mono">{viewing.code}</span>} />
                <Row label="Status" value={<StatusPill status={(viewing as any).active ? "active" : "draft"} />} />
                <Row label="Name" value={viewing.name} />
                <Row label="Phone" value={viewing.phone} />
                <Row label="Email" value={(viewing as any).email} />
                <Row label="Vehicle" value={viewing.vehicleNumber} />
                <Row label="License" value={(viewing as any).licenseNo} />
                <Row label="Period" value={`${(viewing as any).periodFrom ?? "—"} → ${(viewing as any).periodTo ?? "—"}`} />
                <Row label="Bank" value={(viewing as any).bank?.name ?? (viewing as any).bankName} />
                <Row label="Account" value={(viewing as any).bank?.account ?? (viewing as any).accountNo} />
                <Row label="Address" value={(viewing as any).address} />
                <Row label="Routes" value={
                  ((viewing as any).routeIds ?? []).length
                    ? ((viewing as any).routeIds as string[]).map(id => routeMap.get(id)?.code ?? id.slice(0, 6)).join(", ")
                    : "—"
                } />
              </div>
            );
          })()}
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setViewing(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}