// apps/web/src/pages/masters/ContractorsPage.tsx
// ════════════════════════════════════════════════════════════════════
// All Contractors / New Contractor — Marketing v1.4
// ════════════════════════════════════════════════════════════════════

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import PageHeader from "@/components/PageHeader";
import { PageShell, FilterBar, ScrollableTableBody } from "@/components/PageShell";
import { F9SearchSelect, type F9Option } from "@/components/F9SearchSelect";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Edit, X } from "lucide-react";
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

const fmtDate = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
};

export default function ContractorsPage({ tab = "list" }: Props) {
  const qc = useQueryClient();
  const { data: contractors = [], isLoading } = useQuery({
    queryKey: ["contractors"],
    queryFn: fetchContractors,
  });
  const { data: routes = [] } = useQuery({ queryKey: ["routes"], queryFn: fetchRoutes });

  const createMutation = useMutation({
    mutationFn: createContractor,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contractors"] });
      qc.invalidateQueries({ queryKey: ["routes"] }); // routes.contractor_id may change
      toast.success("Contractor created");
    },
    onError: (e: any) => toast.error(e?.message || "Failed to create contractor"),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: ContractorFormData }) => updateContractor(id, data),
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
        <PageHeader title="New Contractor" description="Add a new contractor" />
        <ContractorForm
          onSubmit={async data => {
            await createMutation.mutateAsync(data as any);
          }}
          isSubmitting={createMutation.isPending}
        />
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

// ══════════════════════════════════════════════════════════════════
// List tab
// ══════════════════════════════════════════════════════════════════
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

  const nameOptions: F9Option[] = useMemo(
    () =>
      contractors.map(c => ({
        value: c.id,
        label: c.name,
        sublabel: c.code,
      })),
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

  // Lookup helper for displaying assigned route codes in the table cell
  const routeCodeById = useMemo(() => {
    const m = new Map<string, string>();
    routes.forEach((r: any) => m.set(r.id, r.code));
    return m;
  }, [routes]);

  return (
    <PageShell
      header={
        <>
          <PageHeader title="All Contractors" description="View and manage contractors" />
          <FilterBar>
            <F9SearchSelect
              label="Name"
              value={nameFilter}
              onChange={setNameFilter}
              options={nameOptions}
              allowAll
              className="w-64"
            />
            <F9SearchSelect
              label="Assigned Routes"
              value={routeFilter}
              onChange={setRouteFilter}
              options={routeOptions}
              allowAll
              className="w-56"
            />
            <F9SearchSelect
              label="Status"
              value={statusFilter}
              onChange={setStatusFilter}
              options={STATUS_OPTIONS}
              allowAll
              className="w-44"
            />
            <Button onClick={() => setGenerated(true)}>Generate Table</Button>
            {generated && (
              <Button variant="outline" onClick={clearFilters}>
                <X className="h-4 w-4 mr-1" /> Clear
              </Button>
            )}
          </FilterBar>
        </>
      }
    >
      {!generated ? (
        <EmptyHint message="Set filters above (or leave as All) and click Generate Table." />
      ) : isLoading ? (
        <ScrollableTableBody>
          <div className="p-6 space-y-2">
            {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}
          </div>
        </ScrollableTableBody>
      ) : (
        <ScrollableTableBody>
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-muted/50 backdrop-blur border-b">
              <tr className="text-xs text-muted-foreground">
                <th className="text-left py-2.5 px-3 font-medium">Code</th>
                <th className="text-left py-2.5 px-3 font-medium">Name</th>
                <th className="text-left py-2.5 px-3 font-medium">Phone</th>
                <th className="text-left py-2.5 px-3 font-medium">Vehicle</th>
                <th className="text-left py-2.5 px-3 font-medium">Routes</th>
                <th className="text-left py-2.5 px-3 font-medium">Period From</th>
                <th className="text-left py-2.5 px-3 font-medium">Period To</th>
                <th className="text-left py-2.5 px-3 font-medium">Status</th>
                <th className="text-center py-2.5 px-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(c => (
                <tr key={c.id} className="border-b hover:bg-muted/30">
                  <td className="py-2 px-3 font-mono font-medium">{c.code}</td>
                  <td className="py-2 px-3 font-medium">{c.name}</td>
                  <td className="py-2 px-3 font-mono text-xs">{c.phone}</td>
                  <td className="py-2 px-3 font-mono text-xs">{c.vehicleNumber || "—"}</td>
                  <td className="py-2 px-3 text-xs">
                    {(c.routeIds ?? []).length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {(c.routeIds ?? []).slice(0, 3).map(rid => (
                          <span
                            key={rid}
                            className="font-mono px-1.5 py-0.5 rounded bg-secondary text-secondary-foreground"
                          >
                            {routeCodeById.get(rid) ?? "?"}
                          </span>
                        ))}
                        {(c.routeIds ?? []).length > 3 && (
                          <span className="text-muted-foreground">
                            +{(c.routeIds ?? []).length - 3}
                          </span>
                        )}
                      </div>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="py-2 px-3 text-xs">{fmtDate(c.periodFrom)}</td>
                  <td className="py-2 px-3 text-xs">{fmtDate(c.periodTo)}</td>
                  <td className="py-2 px-3">
                    <span
                      className={`text-xs px-2 py-0.5 rounded ${
                        c.status === "Active"
                          ? "bg-success/10 text-success"
                          : "bg-muted text-muted-foreground"
                      }`}
                    >
                      {c.status}
                    </span>
                  </td>
                  <td className="py-2 px-3">
                    <div className="flex items-center justify-center">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        title="Edit"
                        onClick={() => setEditing(c)}
                      >
                        <Edit className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={9} className="py-10 text-center text-muted-foreground text-sm">
                    No contractors match the selected filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </ScrollableTableBody>
      )}

      {/* Edit dialog */}
      <Dialog open={!!editing} onOpenChange={open => !open && setEditing(null)}>
        <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Contractor — {editing?.code}</DialogTitle>
          </DialogHeader>
          {editing && (
            <ContractorForm
              initialData={editing}
              onCancel={() => setEditing(null)}
              onSubmit={async data => {
                await updateMutation.mutateAsync({ id: editing.id, data });
                setEditing(null);
              }}
              isSubmitting={updateMutation.isPending}
            />
          )}
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}

function EmptyHint({ message }: { message: string }) {
  return (
    <div className="h-full flex items-center justify-center">
      <Card className="max-w-md">
        <CardContent className="p-8 text-center">
          <p className="text-sm text-muted-foreground">{message}</p>
        </CardContent>
      </Card>
    </div>
  );
}