// apps/web/src/pages/masters/CustomersPage.tsx
// ════════════════════════════════════════════════════════════════════
// All Customers / New Customer / Assign Route — Marketing v1.4
//
// Three tabs routed via the `tab` prop:
//   list          → /customers          (PageShell + filter-first)
//   new           → /customers/new      (CustomerForm in create mode)
//   assign-route  → /customers/assign-route (F9 + LiveSearchTable)
// ════════════════════════════════════════════════════════════════════

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import PageHeader from "@/components/PageHeader";
import { PageShell, FilterBar, ScrollableTableBody } from "@/components/PageShell";
import { F9SearchSelect, type F9Option } from "@/components/F9SearchSelect";
import { LiveSearchTable } from "@/components/LiveSearchTable";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Eye, Edit, UserPlus, X } from "lucide-react";
import {
  fetchCustomers,
  fetchRoutes,
  fetchBatches,
  createCustomer,
  updateCustomer,
  removeCustomerFromRoute,
  assignCustomerToRoute,
  type Customer,
} from "@/services/api";
import { CustomerForm } from "@/components/customers/CustomerForm";
import type { CustomerFormData } from "@/lib/validations";

interface Props {
  tab?: "list" | "new" | "assign-route";
}

const TYPE_OPTIONS: F9Option[] = [
  { value: "Retail-Dealer", label: "Retail-Dealer" },
  { value: "Credit Inst-MRP", label: "Credit Inst-MRP" },
  { value: "Credit Inst-Dealer", label: "Credit Inst-Dealer" },
  { value: "Parlour-Dealer", label: "Parlour-Dealer" },
];

// ── Last Indent formatter ──────────────────────────────────────────
function formatLastIndent(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffDays < 0) return d.toLocaleDateString("en-IN");
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

const fmtINR = (n: number | string) =>
  `₹${Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

export default function CustomersPage({ tab = "list" }: Props) {
  const qc = useQueryClient();
  const { data: customers = [], isLoading } = useQuery({ queryKey: ["customers"], queryFn: fetchCustomers });
  const { data: routes = [] } = useQuery({ queryKey: ["routes"], queryFn: fetchRoutes });
  const { data: batches = [] } = useQuery({ queryKey: ["batches"], queryFn: fetchBatches });

  // Letter prefix for auto-code
  const [selectedLetter, setSelectedLetter] = useState("A");
  const nextCode = useMemo(() => {
    const letterCodes = customers
      .filter(c => c.code && c.code.startsWith(selectedLetter))
      .map(c => {
        const num = parseInt(c.code.slice(selectedLetter.length));
        return isNaN(num) ? 0 : num;
      });
    const maxNum = letterCodes.length > 0 ? Math.max(...letterCodes) : 0;
    return `${selectedLetter}${maxNum + 1}`;
  }, [customers, selectedLetter]);

  // Mutations
  const createMutation = useMutation({
    mutationFn: (data: CustomerFormData) => createCustomer({ ...data, code: nextCode }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["customers"] });
      toast.success("Customer created");
    },
    onError: (e: any) => toast.error(e?.message || "Failed to create customer"),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: CustomerFormData }) => updateCustomer(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["customers"] });
      toast.success("Customer updated");
    },
    onError: (e: any) => toast.error(e?.message || "Failed to update customer"),
  });

  // ══════════════════════════════════════════════════════════════════
  // TAB: list
  // ══════════════════════════════════════════════════════════════════
  if (tab === "list") {
    return <CustomerListTab customers={customers} routes={routes} batches={batches} isLoading={isLoading} updateMutation={updateMutation} />;
  }

  // ══════════════════════════════════════════════════════════════════
  // TAB: new
  // ══════════════════════════════════════════════════════════════════
  if (tab === "new") {
    return (
      <div>
        <PageHeader title="New Customer" description="Add a new customer" />
        <CustomerForm
          autoCode={nextCode}
          selectedLetter={selectedLetter}
          onLetterChange={setSelectedLetter}
          onSubmit={async (data) => {
            await createMutation.mutateAsync(data);
          }}
          isSubmitting={createMutation.isPending}
        />
      </div>
    );
  }

  // ══════════════════════════════════════════════════════════════════
  // TAB: assign-route
  // ══════════════════════════════════════════════════════════════════
  return <AssignRouteTab customers={customers} routes={routes} />;
}

// ══════════════════════════════════════════════════════════════════
// List tab — PageShell + filter-first + View/Edit dialogs
// ══════════════════════════════════════════════════════════════════
function CustomerListTab({
  customers,
  routes,
  batches,
  isLoading,
  updateMutation,
}: {
  customers: Customer[];
  routes: any[];
  batches: any[];
  isLoading: boolean;
  updateMutation: any;
}) {
  // Filter state
  const [nameFilter, setNameFilter] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [routeFilter, setRouteFilter] = useState<string | null>(null);
  const [batchFilter, setBatchFilter] = useState<string | null>(null);
  const [generated, setGenerated] = useState(false);

  // View/Edit dialog state
  const [viewing, setViewing] = useState<Customer | null>(null);
  const [editing, setEditing] = useState<Customer | null>(null);

  // F9 option lists
  const nameOptions: F9Option[] = useMemo(
    () => customers.map(c => ({ value: c.id, label: c.name, sublabel: c.code })),
    [customers]
  );
  const routeOptions: F9Option[] = useMemo(
    () => routes.map((r: any) => ({ value: r.id, label: r.name, sublabel: r.code })),
    [routes]
  );
  const batchOptions: F9Option[] = useMemo(
    () => batches.map((b: any) => ({ value: b.id, label: b.whichBatch || b.batchCode, sublabel: b.timing })),
    [batches]
  );

  // Client-side filter applied only after user clicks Generate
  const filtered = useMemo(() => {
    if (!generated) return [];
    return customers.filter(c => {
      if (nameFilter && c.id !== nameFilter) return false;
      if (typeFilter && c.type !== typeFilter) return false;
      if (routeFilter) {
        const hasRoute =
          c.routeId === routeFilter ||
          (c.routes ?? []).some((r: any) => r.routeId === routeFilter);
        if (!hasRoute) return false;
      }
      if (batchFilter) {
        // Customer is on this batch if any of their routes is the batch's primary (or any) route
        const batch = batches.find((b: any) => b.id === batchFilter);
        const routeIds = batch?.routeIds ?? [];
        const hasBatch =
          routeIds.includes(c.routeId) ||
          (c.routes ?? []).some((r: any) => routeIds.includes(r.routeId));
        if (!hasBatch) return false;
      }
      return true;
    });
  }, [customers, batches, nameFilter, typeFilter, routeFilter, batchFilter, generated]);

  const clearFilters = () => {
    setNameFilter(null);
    setTypeFilter(null);
    setRouteFilter(null);
    setBatchFilter(null);
    setGenerated(false);
  };

  return (
    <PageShell
      header={
        <>
          <PageHeader title="All Customers" description="View and manage all customers" />
          <FilterBar>
            <F9SearchSelect
              label="Name"
              value={nameFilter}
              onChange={setNameFilter}
              options={nameOptions}
              allowAll
              className="w-56"
            />
            <F9SearchSelect
              label="Type"
              value={typeFilter}
              onChange={setTypeFilter}
              options={TYPE_OPTIONS}
              allowAll
              className="w-52"
            />
            <F9SearchSelect
              label="Route"
              value={routeFilter}
              onChange={setRouteFilter}
              options={routeOptions}
              allowAll
              className="w-56"
            />
            <F9SearchSelect
              label="Batch"
              value={batchFilter}
              onChange={setBatchFilter}
              options={batchOptions}
              allowAll
              className="w-48"
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
            {Array.from({ length: 10 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        </ScrollableTableBody>
      ) : (
        <ScrollableTableBody>
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-muted/50 backdrop-blur border-b">
              <tr className="text-xs text-muted-foreground">
                <th className="text-left py-2.5 px-3 font-medium">Code</th>
                <th className="text-left py-2.5 px-3 font-medium">Name</th>
                <th className="text-left py-2.5 px-3 font-medium">Type</th>
                <th className="text-left py-2.5 px-3 font-medium">Route</th>
                <th className="text-left py-2.5 px-3 font-medium">Phone</th>
                <th className="text-left py-2.5 px-3 font-medium">City</th>
                <th className="text-right py-2.5 px-3 font-medium">Credit Limit</th>
                <th className="text-left py-2.5 px-3 font-medium">Last Indent</th>
                <th className="text-center py-2.5 px-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(c => (
                <tr key={c.id} className="border-b hover:bg-muted/30">
                  <td className="py-2 px-3 font-mono font-medium">{c.code}</td>
                  <td className="py-2 px-3 font-medium">{c.name}</td>
                  <td className="py-2 px-3 text-xs">{c.type}</td>
                  <td className="py-2 px-3 text-xs">{c.routeCode ? `${c.routeCode} — ${c.routeName}` : "—"}</td>
                  <td className="py-2 px-3 font-mono text-xs">{c.phone}</td>
                  <td className="py-2 px-3 text-xs">{c.city || "—"}</td>
                  <td className="py-2 px-3 text-xs text-right font-mono">
                    {fmtINR(c.creditLimit ?? 0)}
                  </td>
                  <td className="py-2 px-3 text-xs">{formatLastIndent(c.lastIndentAt)}</td>
                  <td className="py-2 px-3">
                    <div className="flex items-center justify-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        title="View details"
                        onClick={() => setViewing(c)}
                      >
                        <Eye className="h-3.5 w-3.5" />
                      </Button>
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
                    No customers match the selected filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </ScrollableTableBody>
      )}

      {/* View dialog */}
      <CustomerDetailDialog customer={viewing} onClose={() => setViewing(null)} />

      {/* Edit dialog */}
      <Dialog open={!!editing} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Customer — {editing?.code}</DialogTitle>
          </DialogHeader>
          {editing && (
            <CustomerForm
              initialData={editing}
              onCancel={() => setEditing(null)}
              onSubmit={async (data) => {
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

// ══════════════════════════════════════════════════════════════════
// Customer detail (read-only) dialog
// ══════════════════════════════════════════════════════════════════
function CustomerDetailDialog({
  customer,
  onClose,
}: {
  customer: Customer | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={!!customer} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{customer?.name} ({customer?.code})</DialogTitle>
        </DialogHeader>
        {customer && (
          <div className="space-y-4 text-sm">
            <DetailSection title="Identity">
              <DetailRow label="Name" value={customer.name} />
              <DetailRow label="Phone" value={customer.phone} />
              <DetailRow label="Email" value={customer.email || "—"} />
              <DetailRow label="Status" value={customer.status} />
            </DetailSection>

            <DetailSection title="Business">
              <DetailRow label="Type" value={customer.type} />
              <DetailRow label="Rate Category" value={customer.rateCategory} />
              <DetailRow label="Pay Mode" value={customer.payMode} />
              <DetailRow label="Officer" value={customer.officerName || "—"} />
              <DetailRow label="Bank" value={customer.bank || "—"} />
              <DetailRow label="Account No." value={customer.accountNo || "—"} />
              <DetailRow label="Credit Limit" value={fmtINR(customer.creditLimit ?? 0)} />
              <DetailRow label="Wallet Balance" value={fmtINR(customer.creditBalance ?? 0)} />
              <DetailRow label="Last Indent" value={formatLastIndent(customer.lastIndentAt)} />
            </DetailSection>

            <DetailSection title="Address">
              <DetailRow label="Address Type" value={customer.addressType || "—"} />
              <DetailRow label="State" value={customer.state || "—"} />
              <DetailRow label="Taluka" value={customer.zoneName || "—"} />
              <DetailRow label="City" value={customer.city || "—"} />
              <DetailRow label="Area" value={customer.area || "—"} />
              <DetailRow label="House No." value={customer.houseNo || "—"} />
              <DetailRow label="Street" value={customer.street || "—"} />
              <DetailRow label="Full Address" value={customer.address || "—"} />
            </DetailSection>

            <DetailSection title="Routes">
              {customer.routes && customer.routes.length > 0 ? (
                <ul className="col-span-2 space-y-1">
                  {customer.routes.map((r: any) => (
                    <li key={r.routeId} className="flex items-center gap-2">
                      <span className="font-mono text-xs">{r.routeCode}</span>
                      <span>{r.routeName}</span>
                      {r.isPrimary && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary">
                          Primary
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted-foreground col-span-2">No routes assigned.</p>
              )}
            </DetailSection>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-2">{title}</h3>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">{children}</div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string | number }) {
  return (
    <>
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </>
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

// ══════════════════════════════════════════════════════════════════
// Assign Route tab — F9 + LiveSearchTable
// ══════════════════════════════════════════════════════════════════
function AssignRouteTab({ customers, routes }: { customers: Customer[]; routes: any[] }) {
  const qc = useQueryClient();
  const [selectedRoute, setSelectedRoute] = useState<string | null>(null);

  const assignMutation = useMutation({
    mutationFn: ({ customerId, routeId }: { customerId: string; routeId: string }) =>
      assignCustomerToRoute(customerId, routeId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["customers"] });
      toast.success("Customer assigned to route");
    },
    onError: (e: any) => toast.error(e?.message || "Failed to assign customer"),
  });

  const removeMutation = useMutation({
    mutationFn: ({ customerId, routeId }: { customerId: string; routeId: string }) =>
      removeCustomerFromRoute(customerId, routeId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["customers"] });
      toast.success("Route removed from customer");
    },
    onError: (e: any) => toast.error(e?.message || "Failed to remove route"),
  });

  const routeOptions: F9Option[] = useMemo(
    () => routes.map((r: any) => ({ value: r.id, label: r.name, sublabel: r.code })),
    [routes]
  );

  // Customers already on this route
  const routeCustomers = useMemo(() => {
    if (!selectedRoute) return [];
    return customers.filter(
      c =>
        c.routeId === selectedRoute ||
        (c.routes ?? []).some((r: any) => r.routeId === selectedRoute)
    );
  }, [customers, selectedRoute]);

  // Customers NOT yet on this route (for the add-customer F9)
  const addableCustomers: F9Option[] = useMemo(() => {
    if (!selectedRoute) return [];
    return customers
      .filter(c => c.status === "Active")
      .filter(
        c =>
          c.routeId !== selectedRoute &&
          !(c.routes ?? []).some((r: any) => r.routeId === selectedRoute)
      )
      .map(c => ({ value: c.id, label: c.name, sublabel: c.code }));
  }, [customers, selectedRoute]);

  const [customerToAdd, setCustomerToAdd] = useState<string | null>(null);

  const handleAddCustomer = () => {
    if (!customerToAdd || !selectedRoute) return;
    assignMutation.mutate(
      { customerId: customerToAdd, routeId: selectedRoute },
      { onSuccess: () => setCustomerToAdd(null) }
    );
  };

  return (
    <PageShell
      header={
        <>
          <PageHeader title="Assign Route" description="Assign customers to routes" />
          <FilterBar>
            <F9SearchSelect
              label="Select Route"
              value={selectedRoute}
              onChange={setSelectedRoute}
              options={routeOptions}
              className="w-72"
            />
            {selectedRoute && (
              <>
                <F9SearchSelect
                  label="Add Customer to Route"
                  value={customerToAdd}
                  onChange={setCustomerToAdd}
                  options={addableCustomers}
                  className="w-72"
                />
                <Button
                  onClick={handleAddCustomer}
                  disabled={!customerToAdd || assignMutation.isPending}
                >
                  <UserPlus className="h-4 w-4 mr-1" /> Assign
                </Button>
              </>
            )}
          </FilterBar>
        </>
      }
    >
      {!selectedRoute ? (
        <EmptyHint message="Select a route to see and manage its customers." />
      ) : (
        <ScrollableTableBody className="p-4">
          <div className="mb-3">
            <h3 className="text-sm font-medium">
              Customers on {routes.find((r: any) => r.id === selectedRoute)?.name}{" "}
              <span className="text-muted-foreground">({routeCustomers.length})</span>
            </h3>
          </div>
          <LiveSearchTable
            items={routeCustomers}
            getSearchableText={c => `${c.code} ${c.name} ${c.phone} ${c.city}`}
            placeholder="Search by name, code, phone, or city..."
          >
            {filtered => (
              <table className="w-full text-sm">
                <thead className="sticky top-0 z-10 bg-muted/50 backdrop-blur border-b">
                  <tr className="text-xs text-muted-foreground">
                    <th className="text-left py-2.5 px-3 font-medium">Code</th>
                    <th className="text-left py-2.5 px-3 font-medium">Name</th>
                    <th className="text-left py-2.5 px-3 font-medium">Type</th>
                    <th className="text-left py-2.5 px-3 font-medium">Phone</th>
                    <th className="text-left py-2.5 px-3 font-medium">City</th>
                    <th className="text-center py-2.5 px-3 font-medium">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(c => (
                    <tr key={c.id} className="border-b hover:bg-muted/30">
                      <td className="py-2 px-3 font-mono">{c.code}</td>
                      <td className="py-2 px-3 font-medium">{c.name}</td>
                      <td className="py-2 px-3 text-xs">{c.type}</td>
                      <td className="py-2 px-3 font-mono text-xs">{c.phone}</td>
                      <td className="py-2 px-3 text-xs">{c.city || "—"}</td>
                      <td className="py-2 px-3 text-center">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 text-destructive hover:text-destructive"
                          onClick={() =>
                            removeMutation.mutate({ customerId: c.id, routeId: selectedRoute })
                          }
                          disabled={removeMutation.isPending}
                        >
                          <X className="h-3.5 w-3.5 mr-1" /> Remove
                        </Button>
                      </td>
                    </tr>
                  ))}
                  {filtered.length === 0 && (
                    <tr>
                      <td colSpan={6} className="py-10 text-center text-muted-foreground text-sm">
                        {routeCustomers.length === 0
                          ? "No customers on this route yet."
                          : "No matches."}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            )}
          </LiveSearchTable>
        </ScrollableTableBody>
      )}
    </PageShell>
  );
}