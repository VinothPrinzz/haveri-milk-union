import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Eye, Edit, Plus, Search, Download, Printer } from "lucide-react";
import PageHeader, {
  FilterBar, FormSection, Field, FormFooter, StatusPill, fmtDate,
} from "@/components/PageHeader";
import { DataTable, Column } from "@/components/DataTable";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  fetchCustomers, fetchRoutes, fetchZones, createCustomer,
  removeCustomerFromRoute, assignCustomerToRoute,
  getRateCategories, getOfficers,
} from "@/services/api";
import { customerSchema, type CustomerFormData } from "@/lib/validations";
import type { Customer } from "@/data/mockData";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { F9SearchSelect, type F9Option } from "@/components/F9SearchSelect";
import { useEffect } from "react";

interface Props { tab?: "list" | "new" | "assign-route"; }

export default function CustomersPage({ tab = "list" }: Props) {
  const qc = useQueryClient();
  const { data: customers = [], isLoading } = useQuery({ queryKey: ["customers"], queryFn: fetchCustomers });
  const { data: routes = [] } = useQuery({ queryKey: ["routes"], queryFn: fetchRoutes });
  const { data: zones = [] } = useQuery({ queryKey: ["zones"], queryFn: fetchZones });
  const rateCategories = getRateCategories();
  const officers = getOfficers();

  // ── Lifted useState hooks to top level (B.2 fix) ──
  const [viewing, setViewing] = useState<Customer | null>(null);
  const [editing, setEditing] = useState<Customer | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");

  const [selectedRoute, setSelectedRoute] = useState("");
  const [typeFilter, setTypeFilter] = useState("All Types");
  const [search, setSearch] = useState("");
  const [selectedLetter, setSelectedLetter] = useState("A");

  const form = useForm<CustomerFormData>({
    resolver: zodResolver(customerSchema),
    defaultValues: { active: true, payMode: "Cash" },
  });

  const nextCode = useMemo(() => {
    const nums = customers
      .filter(c => c.code && c.code.startsWith(selectedLetter))
      .map(c => parseInt(c.code.slice(selectedLetter.length)) || 0);
    const max = nums.length > 0 ? Math.max(...nums) : 0;
    return `${selectedLetter}${max + 1}`;
  }, [customers, selectedLetter]);

  const createMutation = useMutation({
    mutationFn: (data: CustomerFormData) => createCustomer({ ...data, code: nextCode }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["customers"] }); toast.success("Customer created"); form.reset(); },
    onError: () => toast.error("Failed to create customer"),
  });

  const removeMutation = useMutation({
    mutationFn: ({ customerId, routeId }: { customerId: string; routeId: string }) =>
      removeCustomerFromRoute(customerId, routeId),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["customers"] }); toast.success("Route removed from customer"); },
    onError: (err: any) => toast.error(err?.message || "Failed to remove route"),
  });

  const assignMutation = useMutation({
    mutationFn: ({ customerId, routeId }: { customerId: string; routeId: string }) =>
      assignCustomerToRoute(customerId, routeId),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["customers"] }); toast.success("Customer assigned to route"); },
    onError: () => toast.error("Failed to assign customer"),
  });

  const typeOptions = ["All Types", "Retail-Dealer", "Credit Inst-MRP", "Credit Inst-Dealer", "Parlour-Dealer"];
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

  const filtered = customers.filter(c => {
    const matchType = typeFilter === "All Types" || c.type === typeFilter;
    const matchSearch = !search || c.name.toLowerCase().includes(search.toLowerCase()) || c.code.toLowerCase().includes(search.toLowerCase());
    return matchType && matchSearch;
  });

  // ─── LIST TAB ─────────────────────────────────────────────────
  if (tab === "list") {

    const cols: Column<Customer>[] = [
      { key: "code", header: "Code", cell: c => <span className="font-mono text-[12px]">{c.code}</span>, width: "80px" },
      { key: "name", header: "Name", cell: c => <span className="font-medium">{c.name}</span> },
      { key: "type", header: "Type", cell: c => (
        <span className="text-[11px] px-1.5 py-0.5 rounded bg-secondary text-secondary-foreground">{c.type}</span>
      ) },
      {
        key: "route",
        header: "Route(s)",
        cell: c => c.routes && c.routes.length > 0 ? (
          <div className="flex flex-col gap-0.5">
            {c.routes.map(r => (
              <span key={r.routeId} className="text-[12px]">
                <span className="font-mono">{r.routeCode}</span> — {r.routeName}
                {r.isPrimary && c.routes!.length > 1 && (
                  <span className="ml-1 text-muted-foreground text-[11px]">(primary)</span>
                )}
              </span>
            ))}
          </div>
        ) : <span className="text-muted-foreground">—</span>,
      },
      { key: "phone", header: "Phone", cell: c => c.phone, width: "120px" },
      { key: "pay", header: "Pay", cell: c => c.payMode, width: "70px" },
      {
        key: "actions",
        header: "Actions",
        align: "right",
        width: "180px",
        cell: c => (
          <div className="flex items-center justify-end gap-1.5">
            <Button variant="outline" size="sm" className="h-7 px-2.5 text-[12px]" onClick={() => setViewing(c)}>
              View
            </Button>
            <Button size="sm" className="h-7 px-2.5 text-[12px]" onClick={() => setEditing(c)}>
              Update
            </Button>
          </div>
        ),
      },
    ];

    return (
      <div>
        <PageHeader
          title="All Customers"
          subtitle={`${customers.length} customer(s) registered`}
          actions={
            <>
              <Button variant="outline" size="sm" className="h-8" onClick={() => window.print()}>
                <Printer className="w-3.5 h-3.5 mr-1.5" />Print
              </Button>
              <Button variant="outline" size="sm" className="h-8">
                <Download className="w-3.5 h-3.5 mr-1.5" />Export
              </Button>
              <Button size="sm" className="h-8 bg-primary hover:bg-primary-hover" asChild>
                <a href="/masters/customers/new"><Plus className="w-3.5 h-3.5 mr-1.5" />New Customer</a>
              </Button>
            </>
          }
        />
        <FilterBar>
          <Field label="Search">
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
              <Input placeholder="Code or name…" value={search} onChange={e => setSearch(e.target.value)} className="erp-input pl-8 w-56" />
            </div>
          </Field>
          <Field label="Type">
            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger className="erp-input w-44"><SelectValue /></SelectTrigger>
              <SelectContent>{typeOptions.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <div className="ml-auto text-[11px] text-muted-foreground self-center num">
            {filtered.length} of {customers.length}
          </div>
        </FilterBar>
        <div className="p-4">
          <DataTable columns={cols} rows={filtered} isLoading={isLoading} empty="No customers match the current filter." />
        </div>

        <CustomerViewDialog customer={viewing} routes={routes} onClose={() => setViewing(null)} />
        <CustomerEditDialog
          customer={editing}
          routes={routes}
          zones={zones}
          rateCategories={rateCategories}
          officers={officers}
          onClose={() => setEditing(null)}
          onSaved={() => qc.invalidateQueries({ queryKey: ["customers"] })}
        />
      </div>
    );
  }

  // ─── ASSIGN ROUTE TAB ──────────────────────────────────────────
  if (tab === "assign-route") {

    const routeOpts: F9Option[] = useMemo(
      () => routes.map((r: any) => ({ value: r.id, label: r.name, sublabel: r.code })),
      [routes]
    );

    const routeCustomers = customers.filter(c => c.routes?.some(r => r.routeId === selectedRoute));
    const eligibleToAdd = customers.filter(c => {
      if (!selectedRoute) return false;
      if (c.routes?.some(r => r.routeId === selectedRoute)) return false;
      if (!pickerQuery.trim()) return true;
      const q = pickerQuery.trim().toLowerCase();
      return c.name.toLowerCase().includes(q) || c.code.toLowerCase().includes(q) || (c.phone ?? "").includes(q);
    });

    return (
      <div>
        <PageHeader
          title="Assign Route"
          subtitle="Add or remove customers on a route"
          actions={
            <Button
              size="sm"
              className="h-8"
              disabled={!selectedRoute}
              onClick={() => { setPickerQuery(""); setPickerOpen(true); }}
            >
              <Plus className="w-3.5 h-3.5 mr-1.5" />Add Customer
            </Button>
          }
        />
        <FilterBar>
          <Field label="Route" hint="F9">
            <F9SearchSelect
              value={selectedRoute || null}
              onChange={v => setSelectedRoute(v ?? "")}
              options={routeOpts}
              className="w-72"
            />
          </Field>
        </FilterBar>

        {!selectedRoute ? (
          <div className="p-4">
            <div className="erp-panel py-12 text-center text-muted-foreground text-[13px]">
              Select a route above to view its customers.
            </div>
          </div>
        ) : (
          <div className="p-4 space-y-3">
            <div className="erp-panel">
              <div className="print-document">
                <div className="px-3 py-2 erp-section-title !mb-0 !border-b !pb-2 flex items-center justify-between">
                  <span>Customers on Route — {routes.find(r => r.id === selectedRoute)?.code}</span>
                  <span className="text-[11px] normal-case font-normal text-muted-foreground num">
                    {routeCustomers.length} on route
                  </span>
                </div>
                <div className="overflow-auto max-h-[calc(100vh-340px)]">
                  <table className="erp-table">
                    <thead>
                      <tr>
                        <th style={{ width: "50px" }}>#</th>
                        <th>Code</th><th>Name</th><th>Type</th><th>Phone</th>
                        <th style={{ textAlign: "right", width: "110px" }}>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {routeCustomers.length === 0 ? (
                        <tr><td colSpan={6} className="text-center text-muted-foreground py-8">
                          No customers assigned. Click <strong>Add Customer</strong> to assign one.
                        </td></tr>
                      ) : routeCustomers.map((c, i) => (
                        <tr key={c.id}>
                          <td className="num">{i + 1}</td>
                          <td className="font-mono text-[12px]">{c.code}</td>
                          <td className="font-medium">{c.name}</td>
                          <td><span className="text-[11px] px-1.5 py-0.5 rounded bg-secondary">{c.type}</span></td>
                          <td>{c.phone}</td>
                          <td style={{ textAlign: "right" }}>
                            <Button
                              variant="ghost" size="sm" className="h-7 px-2 text-destructive hover:text-destructive"
                              onClick={() => removeMutation.mutate({ customerId: c.id, routeId: selectedRoute })}
                            >
                              Remove
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Add-customer picker dialog */}
        <Dialog open={pickerOpen} onOpenChange={o => !o && setPickerOpen(false)}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>
                Add Customer to Route — {routes.find(r => r.id === selectedRoute)?.code}
              </DialogTitle>
            </DialogHeader>
            <Input
              className="erp-input"
              placeholder="Search by code, name, or phone…"
              value={pickerQuery}
              onChange={e => setPickerQuery(e.target.value)}
              autoFocus
            />
            <div className="erp-panel max-h-[50vh] overflow-auto">
              <table className="erp-table">
                <thead>
                  <tr><th>Code</th><th>Name</th><th>Type</th><th>Phone</th><th></th></tr>
                </thead>
                <tbody>
                  {eligibleToAdd.length === 0 ? (
                    <tr><td colSpan={5} className="text-center text-muted-foreground py-6">
                      No customers match. {pickerQuery && "Try a different search."}
                    </td></tr>
                  ) : eligibleToAdd.slice(0, 50).map(c => (
                    <tr key={c.id}>
                      <td className="font-mono text-[12px]">{c.code}</td>
                      <td className="font-medium">{c.name}</td>
                      <td>{c.type}</td>
                      <td>{c.phone}</td>
                      <td>
                        <Button
                          size="sm" className="h-7"
                          onClick={() => {
                            assignMutation.mutate(
                              { customerId: c.id, routeId: selectedRoute },
                              { onSuccess: () => setPickerOpen(false) },
                            );
                          }}
                          disabled={assignMutation.isPending}
                        >
                          Add
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <DialogFooter>
              <Button variant="outline" size="sm" onClick={() => setPickerOpen(false)}>Close</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  // ─── NEW TAB ───────────────────────────────────────────────────
  if (tab === "new") {
    return (
      <div>
        <PageHeader
          title="New Customer"
          subtitle={`Code will be ${nextCode} (auto-assigned).`}
          actions={
            <Button variant="outline" size="sm" className="h-8" asChild>
              <a href="/masters/customers">Cancel</a>
            </Button>
          }
        />
        <div className="p-4 max-w-4xl">
          <CustomerFormBody
            mode="new"
            initial={{ code: nextCode, type: "Retail-Dealer", payMode: "Cash", state: "Karnataka", active: true }}
            routes={routes}
            zones={zones}
            rateCategories={rateCategories}
            officers={officers}
            onCancel={() => history.back()}
            onSaved={() => { qc.invalidateQueries({ queryKey: ["customers"] }); window.location.href = "/masters/customers"; }}
          />
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="New Customer"
        subtitle="Add a new customer master record"
        actions={
          <Button variant="outline" size="sm" className="h-8" onClick={() => form.reset()}>
            Reset
          </Button>
        }
      />
      <form onSubmit={form.handleSubmit(d => createMutation.mutate(d))} className="p-4">
        <FormSection title="Identification" cols={3}>
          <Field label="Customer Code (Auto)">
            <div className="flex gap-2">
              <Select value={selectedLetter} onValueChange={setSelectedLetter}>
                <SelectTrigger className="erp-input w-16"><SelectValue /></SelectTrigger>
                <SelectContent className="max-h-60">
                  {letters.map(l => <SelectItem key={l} value={l}>{l}</SelectItem>)}
                </SelectContent>
              </Select>
              <Input value={nextCode} disabled className="erp-input bg-muted flex-1 font-mono" />
            </div>
          </Field>
          <Field label="Zone" hint="F9" required error={form.formState.errors.zoneId?.message}>
            <Select onValueChange={v => form.setValue("zoneId", v)} value={form.watch("zoneId") || ""}>
              <SelectTrigger className="erp-input"><SelectValue placeholder="Select zone…" /></SelectTrigger>
              <SelectContent>
                {zones.map(z => <SelectItem key={z.id} value={z.id}>{z.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Customer Name" required error={form.formState.errors.name?.message}>
            <Input className="erp-input" placeholder="Enter customer name" {...form.register("name")} />
          </Field>
        </FormSection>

        <FormSection title="Classification" cols={3}>
          <Field label="Customer Type" required error={form.formState.errors.type?.message}>
            <Select onValueChange={v => form.setValue("type", v as any)} value={form.watch("type") || ""}>
              <SelectTrigger className="erp-input"><SelectValue placeholder="Select type…" /></SelectTrigger>
              <SelectContent>
                {["Retail-Dealer","Credit Inst-MRP","Credit Inst-Dealer","Parlour-Dealer"].map(t =>
                  <SelectItem key={t} value={t}>{t}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Rate Category" required error={form.formState.errors.rateCategory?.message}>
            <Select onValueChange={v => form.setValue("rateCategory", v as any)} value={form.watch("rateCategory") || ""}>
              <SelectTrigger className="erp-input"><SelectValue placeholder="Select rate…" /></SelectTrigger>
              <SelectContent>
                {rateCategories.map(r => <SelectItem key={r} value={r}>{r}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Pay Mode" required>
            <Select onValueChange={v => form.setValue("payMode", v as any)} value={form.watch("payMode") || "Cash"}>
              <SelectTrigger className="erp-input"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="Cash">Cash</SelectItem>
                <SelectItem value="Credit">Credit</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </FormSection>

        <FormSection title="Banking & Officer" cols={3}>
          <Field label="Bank">
            <Input className="erp-input" placeholder="Bank name" {...form.register("bank")} />
          </Field>
          <Field label="Officer">
            <Select onValueChange={v => form.setValue("officerName", v)} value={form.watch("officerName") || ""}>
              <SelectTrigger className="erp-input"><SelectValue placeholder="Select officer…" /></SelectTrigger>
              <SelectContent>
                {officers.map(o => <SelectItem key={o.id} value={o.name}>{o.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Phone">
            <Input className="erp-input" placeholder="Phone number" {...form.register("phone")} />
          </Field>
        </FormSection>

        <FormSection title="Address" cols={2}>
        <Field label="City">
          <Input className="erp-input" list="city-suggest" {...form.register("city")} />
          <datalist id="city-suggest">
            {Array.from(new Set(customers.map(c => c.city).filter(Boolean) as string[]))
              .sort()
              .map(city => <option key={city} value={city} />)}
          </datalist>
        </Field>
          <Field label="Address">
            <Input className="erp-input" placeholder="Full address" {...form.register("address")} />
          </Field>
        </FormSection>

        <FormSection title="Status" cols={1}>
          <div className="flex items-center gap-3">
            <Switch checked={form.watch("active")} onCheckedChange={v => form.setValue("active", v)} />
            <span className="text-[13px]">Active</span>
          </div>
        </FormSection>

        <FormFooter>
          <Button type="button" variant="ghost" size="sm" className="h-8" onClick={() => form.reset()}>
            Cancel
          </Button>
          <Button type="submit" size="sm" className="h-8 bg-primary hover:bg-primary-hover" disabled={createMutation.isPending}>
            {createMutation.isPending ? "Saving…" : "Save Customer"}
          </Button>
        </FormFooter>
      </form>
    </div>
  );
}

// ─────────────────────────────────────────────
// View dialog (read-only; full info)
// ─────────────────────────────────────────────

function CustomerViewDialog({
  customer, routes, onClose,
}: {
  customer: Customer | null;
  routes: any[];
  onClose: () => void;
}) {
  if (!customer) return null;
  const Row = ({ label, value }: { label: string; value: any }) => (
    <div className="flex items-baseline gap-2 py-1 border-b border-border/60 last:border-0">
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground w-32 shrink-0">{label}</span>
      <span className="text-[13px] font-medium">{value || <span className="text-muted-foreground">—</span>}</span>
    </div>
  );
  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-[15px]">
            {customer.code} — {customer.name}
          </DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-x-6 gap-y-0">
          <Row label="Code" value={<span className="font-mono">{customer.code}</span>} />
          <Row label="Status" value={<StatusPill status={(customer as any).active ? "active" : "draft"} />} />
          <Row label="Name" value={customer.name} />
          <Row label="Phone" value={customer.phone} />
          <Row label="Email" value={(customer as any).email} />
          <Row label="GST" value={(customer as any).gstNumber || (customer as any).gst} />
          <Row label="Type" value={customer.type} />
          <Row label="Pay Mode" value={customer.payMode} />
          <Row label="Rate Category" value={customer.rateCategory} />
          <Row label="Officer" value={(customer as any).officerName} />
          <Row label="Bank" value={(customer as any).bank} />
          <Row label="Account No." value={(customer as any).accountNo} />
          <Row label="Credit Limit" value={(customer as any).creditLimit != null
            ? `₹${Number((customer as any).creditLimit).toLocaleString("en-IN")}`
            : "—"} />
          <Row label="Address Type" value={(customer as any).addressType} />
          <Row label="State" value={(customer as any).state} />
          <Row label="Taluka" value={routes.find((r: any) => r.id === customer.routeId)?.taluka || (customer as any).zoneName} />
          <Row label="City" value={(customer as any).city} />
          <Row label="Area" value={(customer as any).area} />
          <Row label="House No." value={(customer as any).houseNo} />
          <Row label="Street" value={(customer as any).street} />
          <Row label="Address" value={(customer as any).address} />
          <Row label="Routes" value={
            customer.routes?.length
              ? customer.routes.map(r => `${r.routeCode}${r.isPrimary ? " ★" : ""}`).join(", ")
              : "—"
          } />
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CustomerEditDialog({
  customer, routes, zones, rateCategories, officers, onClose, onSaved,
}: {
  customer: Customer | null;
  routes: any[];
  zones: any[];
  rateCategories: any[];
  officers: any[];
  onClose: () => void;
  onSaved: () => void;
}) {
  if (!customer) return null;
  // Lazy import to avoid circular ref with the page itself.
  // The form renders all the same fields the New form has (see Fix #3).
  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-auto">
        <DialogHeader>
          <DialogTitle>Edit Customer — {customer.code}</DialogTitle>
        </DialogHeader>
        <CustomerFormBody
          mode="edit"
          initial={customer as any}
          routes={routes}
          zones={zones}
          rateCategories={rateCategories}
          officers={officers}
          onCancel={onClose}
          onSaved={() => { onSaved(); onClose(); }}
        />
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────
// CustomerFormBody — shared between New page + Edit dialog
// All F9-able selects go through F9SearchSelect.
// ─────────────────────────────────────────────

function CustomerFormBody({
  mode, initial, routes, zones, rateCategories, officers, onCancel, onSaved,
}: {
  mode: "new" | "edit";
  initial: any;
  routes: any[];
  zones: any[];
  rateCategories: any[];
  officers: any[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const qc = useQueryClient();
  const form = useForm<CustomerFormData & { gstNumber?: string }>({
    resolver: zodResolver(customerSchema),
    defaultValues: {
      name: initial?.name ?? "",
      phone: initial?.phone ?? "",
      email: initial?.email ?? "",
      type: initial?.type ?? "Retail-Dealer",
      rateCategory: initial?.rateCategory ?? "Retail-Dealer",
      payMode: initial?.payMode ?? "Cash",
      officerName: initial?.officerName ?? "",
      bank: initial?.bank ?? "",
      accountNo: initial?.accountNo ?? "",
      creditLimit: initial?.creditLimit ?? 0,
      addressType: initial?.addressType ?? "",
      state: initial?.state ?? "Karnataka",
      zoneId: initial?.zoneId ?? "",
      city: initial?.city ?? "",
      area: initial?.area ?? "",
      houseNo: initial?.houseNo ?? "",
      street: initial?.street ?? "",
      address: initial?.address ?? "",
      routeId: initial?.routeId ?? (initial?.routes?.find((r: any) => r.isPrimary)?.routeId ?? ""),
      active: initial?.active ?? true,
    } as any,
  });

  // GST is not in customerSchema yet — keep it as a separate controlled field.
  const [gstNumber, setGstNumber] = useState<string>(initial?.gstNumber ?? initial?.gst ?? "");

  const save = useMutation({
    mutationFn: async (d: CustomerFormData) => {
      const payload = { ...d, gstNumber, code: initial?.code };
      if (mode === "new") return createCustomer(payload as any);
      const { updateCustomer } = await import("@/services/api"); // lazy to avoid circular
      return updateCustomer(initial.id, payload as any);
    },
    onSuccess: () => {
      toast.success(mode === "new" ? "Customer created" : "Customer updated");
      qc.invalidateQueries({ queryKey: ["customers"] });
      onSaved();
    },
    onError: (e: any) => toast.error(e?.message || "Save failed"),
  });

  // F9 option lists
  const zoneOpts: F9Option[]     = useMemo(() => zones.map((z: any) => ({ value: z.id, label: z.name })), [zones]);
  const officerOpts: F9Option[]  = useMemo(() => (officers ?? []).map((o: any) => ({ value: o.name ?? o.id, label: o.name ?? o })), [officers]);
  const rateCatOpts: F9Option[]  = useMemo(() => (rateCategories ?? []).map((r: any) => ({ value: r.value ?? r, label: r.label ?? r })), [rateCategories]);
  const routeOpts: F9Option[]    = useMemo(() => routes.map((r: any) => ({ value: r.id, label: r.name, sublabel: r.code })), [routes]);

  // Distinct cities derived from existing dealers — populated lazily.
  const { data: existingCustomers = [] } = useQuery({ queryKey: ["customers"], queryFn: fetchCustomers });
  const cityOpts: F9Option[] = useMemo(() => {
    const set = new Set<string>();
    existingCustomers.forEach((c: any) => { if (c.city) set.add(c.city); });
    return Array.from(set).sort().map(c => ({ value: c, label: c }));
  }, [existingCustomers]);

  return (
    <form onSubmit={form.handleSubmit(d => save.mutate(d))} className="space-y-3 pb-20">
      <FormSection title="Identity" cols={3}>
        <Field label="Code" hint="auto">
          <Input className="erp-input bg-muted" value={initial?.code ?? ""} readOnly />
        </Field>
        <Field label="Name" required error={form.formState.errors.name?.message}>
          <Input className="erp-input" {...form.register("name")} />
        </Field>
        <Field label="Phone" required error={form.formState.errors.phone?.message}>
          <Input className="erp-input" {...form.register("phone")} maxLength={10} />
        </Field>
        <Field label="Email" error={form.formState.errors.email?.message}>
          <Input className="erp-input" {...form.register("email")} placeholder="email@example.com" />
        </Field>
        <Field label="GST No.">
          <Input className="erp-input" value={gstNumber} onChange={e => setGstNumber(e.target.value.toUpperCase())} placeholder="22AAAAA0000A1Z5" />
        </Field>
        <Field label="Status">
          <div className="flex items-center gap-2 h-10">
            <Switch checked={form.watch("active")} onCheckedChange={v => form.setValue("active", v)} />
            <span className="text-[13px]">{form.watch("active") ? "Active" : "Inactive"}</span>
          </div>
        </Field>
      </FormSection>

      <FormSection title="Business" cols={3}>
        <Field label="Type" required>
          <Select value={form.watch("type")} onValueChange={v => form.setValue("type", v as any)}>
            <SelectTrigger className="erp-input"><SelectValue /></SelectTrigger>
            <SelectContent>
              {["Retail-Dealer","Credit Inst-MRP","Credit Inst-Dealer","Parlour-Dealer"].map(t =>
                <SelectItem key={t} value={t}>{t}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Rate Category" hint="F9">
          <F9SearchSelect
            value={form.watch("rateCategory") ?? null}
            onChange={v => form.setValue("rateCategory", v ?? "")}
            options={rateCatOpts}
            className="w-full"
          />
        </Field>
        <Field label="Pay Mode">
          <Select value={form.watch("payMode")} onValueChange={v => form.setValue("payMode", v as any)}>
            <SelectTrigger className="erp-input"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="Cash">Cash</SelectItem>
              <SelectItem value="Credit">Credit</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Officer" hint="F9">
          <F9SearchSelect
            value={form.watch("officerName") || null}
            onChange={v => form.setValue("officerName", v ?? "")}
            options={officerOpts}
            className="w-full"
          />
        </Field>
        <Field label="Bank">
          <Input className="erp-input" {...form.register("bank")} />
        </Field>
        <Field label="Account No.">
          <Input className="erp-input" {...form.register("accountNo")} />
        </Field>
        <Field label="Credit Limit">
          <Input
            className="erp-input num"
            type="number" step="0.01" min="0"
            {...form.register("creditLimit", { valueAsNumber: true })}
          />
        </Field>
        <Field label="Primary Route" hint="F9">
          <F9SearchSelect
            value={form.watch("routeId") || null}
            onChange={v => form.setValue("routeId", v ?? "")}
            options={routeOpts}
            className="w-full"
          />
        </Field>
      </FormSection>

      <FormSection title="Address" cols={3}>
        <Field label="Address Type">
          <Select value={form.watch("addressType") || ""} onValueChange={v => form.setValue("addressType", v as any)}>
            <SelectTrigger className="erp-input"><SelectValue placeholder="Select…" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="Office">Office</SelectItem>
              <SelectItem value="Residence">Residence</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="State">
          <Input className="erp-input" {...form.register("state")} />
        </Field>
        <Field label="Taluka / Zone" hint="F9">
          <F9SearchSelect
            value={form.watch("zoneId") || null}
            onChange={v => form.setValue("zoneId", v ?? "")}
            options={zoneOpts}
            className="w-full"
          />
        </Field>
        <Field label="City" hint="F9">
          <F9SearchSelect
            value={form.watch("city") || null}
            onChange={v => form.setValue("city", v ?? "")}
            options={cityOpts}
            className="w-full"
          />
        </Field>
        <Field label="Area">
          <Input className="erp-input" {...form.register("area")} />
        </Field>
        <Field label="House No.">
          <Input className="erp-input" {...form.register("houseNo")} />
        </Field>
        <Field label="Street">
          <Input className="erp-input" {...form.register("street")} />
        </Field>
        <Field label="Full Address">
          <Input className="erp-input" {...form.register("address")} placeholder="Free-form, optional" />
        </Field>
      </FormSection>

      <FormFooter>
        <Button type="button" variant="ghost" size="sm" className="h-8" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          className="h-8 bg-primary hover:bg-primary-hover"
          disabled={save.isPending}
          onClick={() => form.handleSubmit(d => save.mutate(d))()}
        >
          {save.isPending ? "Saving..." : "Save Customer"}
        </Button>
      </FormFooter>
    </form>
  );
}