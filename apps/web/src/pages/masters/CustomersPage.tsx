import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Plus, Search, Download, ChevronLeft, ChevronRight } from "lucide-react";
import PageHeader, {
  FilterBar, FormSection, Field, FormFooter, StatusPill,
} from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  fetchCustomers, fetchCustomersPage, fetchRoutes, fetchZones, createCustomer,
  removeCustomerFromRoute, assignCustomerToRoute,
  fetchEmployees, assignEmployeeToRoute, removeEmployeeFromRoute,
  getRateCategories, getOfficers
} from "@/services/api";
import { customerSchema, type CustomerFormData } from "@/lib/validations";
import { useSaveShortcut } from "@/lib/useKeyboardNav";
import type { Customer } from "@/data/mockData";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { F9SearchSelect, type F9Option } from "@/components/F9SearchSelect";
import { toCsv } from "@/lib/exporters";
import { patch } from "@/lib/apiClient";
 
interface Props { tab?: "list" | "new" | "assign-route"; }
 
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const TYPE_OPTIONS = ["All Types", "Retail-Dealer", "Credit Inst-MRP", "Credit Inst-Dealer", "Parlour-Dealer"];
 
export default function CustomersPage({ tab = "list" }: Props) {
  const qc = useQueryClient();
 
  // ── ALL hooks at top — never inside conditionals (fixes React #310) ──
  const { data: routes = [] } = useQuery({ queryKey: ["routes"], queryFn: fetchRoutes });
  const { data: zones  = [] } = useQuery({ queryKey: ["zones"],  queryFn: fetchZones  });
  const { data: employees = [] } = useQuery({
    queryKey: ["employees-all"],
    queryFn: () => fetchEmployees(),
  });
 
  // Full customer list (paginated server-side; populates F9 selects across the page)
  const { data: allCustomers = [] } = useQuery({
    queryKey: ["customers"],
    queryFn: fetchCustomers,
  });
 
  const rateCategories = getRateCategories();
  const officers = getOfficers();
 
  // Server-side pagination for /list tab
  const [page, setPage]               = useState(1);
  const [pageSize, setPageSize]       = useState(25);
  const [search, setSearch]           = useState("");
  const [debouncedSearch, setDebSearch] = useState("");
  const [typeFilter, setTypeFilter]   = useState("All Types");
  const [routeFilter, setRouteFilter] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<"all" | "true" | "false">("all");
 
  useEffect(() => {
    const t = setTimeout(() => { setDebSearch(search); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [search]);
 
  useEffect(() => { setPage(1); }, [typeFilter, routeFilter, statusFilter, pageSize]);
 
  const pageQuery = useQuery({
    queryKey: ["customers-page", { page, pageSize, debouncedSearch, typeFilter, routeFilter, statusFilter }],
    queryFn: () => fetchCustomersPage({
      page, limit: pageSize,
      search:        debouncedSearch || undefined,
      customerType:  typeFilter !== "All Types" ? typeFilter : undefined,
      routeId:       routeFilter ?? undefined,
      activeFilter: statusFilter !== "all" ? statusFilter as "true" | "false" : undefined,
    }),
    placeholderData: keepPreviousData,
  });
  const pageRows = pageQuery.data?.rows ?? [];
  const totalPages = pageQuery.data?.totalPages ?? 1;
  const totalCount = pageQuery.data?.total ?? 0;
 
  // Dialog state
  const [viewing, setViewing]       = useState<Customer | null>(null);
  const [editing, setEditing]       = useState<Customer | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
 
  // Assign-route state
  const [selectedRoute, setSelectedRoute] = useState("");

  // === Position management for assign-route tab ===
  const [pendingPos, setPendingPos] = useState<Record<string, number>>({});

  const movePos = (dealerId: string, dir: "up" | "down") => {
    const idx = routeCustomers.findIndex((c: any) => c.id === dealerId);
    const swapIdx = dir === "up" ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= routeCustomers.length) return;

    const a = routeCustomers[idx]._pos;
    const b = routeCustomers[swapIdx]._pos;

    setPendingPos((p) => ({
      ...p,
      [routeCustomers[idx].id]: b,
      [routeCustomers[swapIdx].id]: a,
    }));
  };

  const savePosMutation = useMutation({
    mutationFn: async () => {
      const dealerPos: { dealerId: string; position: number }[] = [];
      const empPos:    { employeeId: string; position: number }[] = [];
      for (const [id, position] of Object.entries(pendingPos)) {
        const row = routeCustomers.find((c: any) => c.id === id);
        if (row?.kind === "employee") empPos.push({ employeeId: id, position });
        else dealerPos.push({ dealerId: id, position });
      }
      await Promise.all([
        dealerPos.length
          ? patch(`/routes/${selectedRoute}/dealer-positions`,   { positions: dealerPos })
          : Promise.resolve(),
        empPos.length
          ? patch(`/routes/${selectedRoute}/employee-positions`, { positions: empPos })
          : Promise.resolve(),
      ]);
    },
    onSuccess: () => {
      setPendingPos({});
      qc.invalidateQueries({ queryKey: ["customers"] });
      qc.invalidateQueries({ queryKey: ["employees-all"] });
      toast.success("Positions saved");
    },
    onError: () => toast.error("Failed to save positions"),
  });

  const assignEmpMutation = useMutation({
    mutationFn: ({ employeeId, routeId }: { employeeId: string; routeId: string }) =>
      assignEmployeeToRoute(employeeId, routeId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["employees-all"] });
      toast.success("Employee assigned to route");
    },
    onError: () => toast.error("Failed to assign employee"),
  });

  const removeEmpMutation = useMutation({
    mutationFn: (employeeId: string) => removeEmployeeFromRoute(employeeId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["employees-all"] });
      toast.success("Employee removed from route");
    },
    onError: () => toast.error("Failed to remove employee"),
  });
 
  // New-customer alphabet state (used by both /new tab AND fallback form)
  const [selectedLetter, setSelectedLetter] = useState("A");
 
  // F9 options derived ONCE at top level (Hooks rule)
  const routeOpts: F9Option[] = useMemo(
    () => routes.map((r: any) => ({ value: r.id, label: r.name, sublabel: r.code })),
    [routes],
  );
 
  // Code auto-generation — based on full dealer dataset (so codes stay unique)
  const nextCode = useMemo(() => {
    const nums = allCustomers
      .filter((c: any) => c.code && c.code.startsWith(selectedLetter))
      .map((c: any) => parseInt(c.code.slice(selectedLetter.length)) || 0);
    const max = nums.length > 0 ? Math.max(...nums) : 0;
    return `${selectedLetter}${max + 1}`;
  }, [allCustomers, selectedLetter]);
 
  // Mutations
  const createMutation = useMutation({
    mutationFn: (data: CustomerFormData) => createCustomer({ ...data, code: nextCode }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["customers"] });
      qc.invalidateQueries({ queryKey: ["customers-page"] });
      toast.success("Customer created");
    },
    onError: () => toast.error("Failed to create customer"),
  });
 
  const removeMutation = useMutation({
    mutationFn: ({ customerId, routeId }: { customerId: string; routeId: string }) =>
      removeCustomerFromRoute(customerId, routeId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["customers"] });
      qc.invalidateQueries({ queryKey: ["customers-page"] });
      toast.success("Route removed from customer");
    },
    onError: (err: any) => toast.error(err?.message || "Failed to remove route"),
  });
 
  const assignMutation = useMutation({
    mutationFn: ({ customerId, routeId }: { customerId: string; routeId: string }) =>
      assignCustomerToRoute(customerId, routeId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["customers"] });
      qc.invalidateQueries({ queryKey: ["customers-page"] });
      toast.success("Customer assigned to route");
    },
    onError: () => toast.error("Failed to assign customer"),
  });
 
  // Dealers currently on the selected route
  const routeDealers = allCustomers
    .map((c: any) => {
      const link = c.routes?.find((r: any) => r.routeId === selectedRoute);
      return link ? { ...c, kind: "dealer" as const, _pos: link.position ?? 9999 } : null;
    })
    .filter(Boolean);

  // Employees currently on the selected route (Option A: single route_id)
  const routeEmployeeRows = (employees as any[])
    .filter((e: any) => e.route_id === selectedRoute)
    .map((e: any) => ({
      id: e.id,
      code: e.employee_code ?? "",
      name: e.name,
      type: "Employee",
      phone: e.phone ?? "",
      kind: "employee" as const,
      _pos: e.route_position ?? 9999,
    }));

  // Merged + ordered by position (dealers and employees interleaved)
  const routeCustomers = [...routeDealers, ...routeEmployeeRows]
    .sort((a: any, b: any) => {
      const posA = pendingPos[a.id] ?? a._pos;
      const posB = pendingPos[b.id] ?? b._pos;
      return (posA - posB)
        || (a.code || "").localeCompare(b.code || "")
        || a.name.localeCompare(b.name);
    });

  // Add-picker: dealers + employees NOT already on this route
  const eligibleToAdd = [
    ...allCustomers
      .filter((c: any) => !c.routes?.some((r: any) => r.routeId === selectedRoute))
      .map((c: any) => ({
        id: c.id, code: c.code, name: c.name,
        type: c.type, phone: c.phone, kind: "dealer" as const,
      })),
    ...(employees as any[])
      .filter((e: any) => e.route_id !== selectedRoute)
      .map((e: any) => ({
        id: e.id, code: e.employee_code ?? "", name: e.name,
        type: "Employee", phone: e.phone ?? "", kind: "employee" as const,
      })),
  ].filter((c: any) => {
    if (!selectedRoute) return false;
    if (!pickerQuery.trim()) return true;
    const q = pickerQuery.trim().toLowerCase();
    return c.name.toLowerCase().includes(q)
        || (c.code || "").toLowerCase().includes(q)
        || (c.phone ?? "").toString().includes(q);
  });
 
  const [exporting, setExporting] = useState(false);
  const exportCsv = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      // Fetch ALL customers matching the current filters (every page), not just the page on screen.
      const baseParams = {
        limit: 100,
        search:       debouncedSearch || undefined,
        customerType: typeFilter !== "All Types" ? typeFilter : undefined,
        routeId:      routeFilter ?? undefined,
        activeFilter: statusFilter !== "all" ? (statusFilter as "true" | "false") : undefined,
      };

      const first = await fetchCustomersPage({ ...baseParams, page: 1 });
      const allRows = [...first.rows];
      if (first.totalPages > 1) {
        const pages = Array.from({ length: first.totalPages - 1 }, (_, i) => i + 2);
        const rest = await Promise.all(
          pages.map((p) => fetchCustomersPage({ ...baseParams, page: p })),
        );
        rest.forEach((r) => allRows.push(...r.rows));
      }

      const header = ["Code", "Name", "Type", "Routes", "Phone", "Pay Mode", "City", "Status"];
      const data = allRows.map((c: any) => [
        c.code, c.name, c.type,
        (c.routes ?? []).map((r: any) => r.routeCode).join(" | "),
        c.phone, c.payMode, c.city,
        c.active === false ? "Inactive" : "Active",
      ]);
      const csv = toCsv([header, ...data]);
      const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const ts = new Date().toISOString().slice(0, 10);
      a.href = url; a.download = `customers_${ts}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`Exported ${data.length} row(s)`);
    } catch {
      toast.error("Failed to export customers");
    } finally {
      setExporting(false);
    }
  };
 
  // ─────────────────────────────────────────────────────────────────
  // ASSIGN-ROUTE TAB
  // ─────────────────────────────────────────────────────────────────
  if (tab === "assign-route") {
    return (
      <div>
        <PageHeader
          title="Assign Route"
          subtitle="Add or remove customers and employees on a route"
          actions={
            <Button
              size="sm" className="h-8" disabled={!selectedRoute}
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
              <div className="px-3 py-2 erp-section-title !mb-0 !border-b !pb-2 flex items-center justify-between">
                <span>Customers on Route — {routes.find((r: any) => r.id === selectedRoute)?.code}</span>
                <span className="text-[11px] normal-case font-normal text-muted-foreground num">
                  {routeCustomers.length} on route
                </span>

                {/* === Save Order Button === */}
                {Object.keys(pendingPos).length > 0 && (
                  <Button 
                    size="sm" 
                    className="h-7 ml-2"
                    disabled={savePosMutation.isPending}
                    onClick={() => savePosMutation.mutate()}
                  >
                    Save order ({Object.keys(pendingPos).length})
                  </Button>
                )}
              </div>
              <div className="overflow-auto max-h-[calc(100vh-340px)]">
                <table className="erp-table">
                <thead>
                  <tr>
                    <th style={{ width: "50px" }}>#</th>
                    <th style={{ width: "90px" }}>Position</th>
                    <th>Code</th><th>Name</th><th>Type</th><th>Phone</th>
                    <th style={{ textAlign: "right", width: "180px" }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {routeCustomers.map((c: any, i: number) => (
                    <tr key={c.id}>
                      <td className="num">{i + 1}</td>
                      <td>
                        <Input
                          type="number"
                          min={1}
                          className="erp-input h-7 w-16 num"
                          defaultValue={c._pos}
                          onBlur={(e) => {
                            const next = parseInt(e.target.value, 10);
                            if (Number.isFinite(next) && next !== c._pos) {
                              setPendingPos((p) => ({ ...p, [c.id]: next }));
                            }
                          }}
                        />
                      </td>
                      <td className="font-mono text-[12px]">{c.code}</td>
                      <td className="font-medium">{c.name}</td>
                      <td><span className="text-[11px] px-1.5 py-0.5 rounded bg-secondary">{c.type}</span></td>
                      <td>{c.phone}</td>
                      <td style={{ textAlign: "right" }}>
                        <Button
                          variant="ghost" size="sm"
                          className="h-7 px-2 text-destructive hover:text-destructive"
                          onClick={() => {
                            if (c.kind === "employee") removeEmpMutation.mutate(c.id);
                            else removeMutation.mutate({ customerId: c.id, routeId: selectedRoute });
                          }}
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
        )}
 
        <Dialog open={pickerOpen} onOpenChange={o => !o && setPickerOpen(false)}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>
                Add Customer to Route — {routes.find((r: any) => r.id === selectedRoute)?.code}
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
                  ) : eligibleToAdd.slice(0, 50).map((c: any) => (
                    <tr key={c.id}>
                      <td className="font-mono text-[12px]">{c.code}</td>
                      <td className="font-medium">{c.name}</td>
                      <td>{c.type}</td>
                      <td>{c.phone}</td>
                      <td>
                        <Button
                          size="sm" className="h-7"
                          onClick={() => {
                            if (c.kind === "employee") {
                              assignEmpMutation.mutate(
                                { employeeId: c.id, routeId: selectedRoute },
                                { onSuccess: () => setPickerOpen(false) },
                              );
                            } else {
                              assignMutation.mutate(
                                { customerId: c.id, routeId: selectedRoute },
                                { onSuccess: () => setPickerOpen(false) },
                              );
                            }
                          }}
                          disabled={assignMutation.isPending || assignEmpMutation.isPending}
                        >Add</Button>
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
 
  // ─────────────────────────────────────────────────────────────────
  // NEW TAB
  // ─────────────────────────────────────────────────────────────────
  if (tab === "new") {
    return (
      <div>
        <PageHeader
          title="New Customer"
          subtitle={`Code will be ${nextCode} (auto-generated from selected letter).`}
          actions={
            <Button variant="outline" size="sm" className="h-8" asChild>
              <a href="/masters/customers">Cancel</a>
            </Button>
          }
        />
        <div className="p-4 max-w-4xl space-y-3">
          {/* B3: alphabet selector — drives nextCode */}
          <div className="erp-panel p-3">
            <div className="grid grid-cols-2 gap-3 max-w-xl">
              <Field label="Code Prefix (Alphabet)" required>
                <Select value={selectedLetter} onValueChange={setSelectedLetter}>
                  <SelectTrigger className="erp-input"><SelectValue /></SelectTrigger>
                  <SelectContent className="max-h-72">
                    {LETTERS.map(l => (
                      <SelectItem key={l} value={l}>{l}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Generated Code">
                <Input className="erp-input bg-muted font-mono" value={nextCode} disabled />
              </Field>
            </div>
          </div>
 
          <CustomerFormBody
            mode="new"
            initial={{
              code: nextCode,
              type: "Retail-Dealer", payMode: "Cash",
              state: "Karnataka", active: true,
            }}
            routes={routes}
            zones={zones}
            rateCategories={rateCategories}
            officers={officers}
            onCancel={() => history.back()}
            onSaved={() => {
              qc.invalidateQueries({ queryKey: ["customers"] });
              qc.invalidateQueries({ queryKey: ["customers-page"] });
              window.location.href = "/masters/customers";
            }}
          />
        </div>
      </div>
    );
  }
 
  // ─────────────────────────────────────────────────────────────────
  // LIST TAB
  // ─────────────────────────────────────────────────────────────────
  return (
    <div>
      <PageHeader
        title="All Customers"
        subtitle={`${totalCount} customer(s) registered`}
        actions={
          <>
            <Button variant="outline" size="sm" className="h-8" onClick={exportCsv} disabled={exporting}>
              <Download className="w-3.5 h-3.5 mr-1.5" />{exporting ? "Exporting…" : "Export CSV"}
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
            <Input placeholder="Code, name, or phone…" value={search}
                   onChange={e => setSearch(e.target.value)}
                   className="erp-input pl-8 w-64" />
          </div>
        </Field>
        <Field label="Type">
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="erp-input w-44"><SelectValue /></SelectTrigger>
            <SelectContent>{TYPE_OPTIONS.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        <Field label="Route" hint="F9">
         <F9SearchSelect
           value={routeFilter}
           onChange={setRouteFilter}
           options={routeOpts}
           allowAll
           className="w-56"
         />
       </Field>
       <Field label="Status">
       <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as "all" | "true" | "false")}>
        <SelectTrigger className="erp-input w-32"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All</SelectItem>
          <SelectItem value="true">Active</SelectItem>
          <SelectItem value="false">Inactive</SelectItem>
        </SelectContent>
       </Select>
       </Field>
       <div className="ml-auto text-[11px] text-muted-foreground self-center num">
          {pageRows.length} on page · {totalCount} total
        </div>
      </FilterBar>
 
      <div className="p-4 space-y-3">
        <div className="erp-panel overflow-hidden">
          <div className="overflow-auto max-h-[calc(100vh-320px)]">
            <table className="erp-table">
              <thead>
                <tr>
                <th style={{ width: 80 }}>Code</th>
                <th>Name</th>
                <th>Type</th>
                <th>Route(s)</th>
                <th style={{ width: 120 }}>Phone</th>
                <th style={{ width: 70 }}>Pay</th>
                <th style={{ width: 80 }}>Status</th>
                <th style={{ width: 180, textAlign: "right" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {pageQuery.isLoading ? (
                  Array.from({ length: 8 }).map((_, i) => (
                    <tr key={`s${i}`}>
                      {Array.from({ length: 7 }).map((_, j) => (
                        <td key={j}><div className="h-3.5 bg-muted/70 rounded-sm animate-pulse" /></td>
                      ))}
                    </tr>
                  ))
                ) : pageRows.length === 0 ? (
                  <tr><td colSpan={8} className="text-center py-8 text-muted-foreground">
                    No customers match the current filter.
                  </td></tr>
                ) : pageRows.map((c: any) => (
                  <tr key={c.id}>
                    <td className="font-mono text-[12px]">{c.code}</td>
                    <td className="font-medium">{c.name}</td>
                    <td><span className="text-[11px] px-1.5 py-0.5 rounded bg-secondary text-secondary-foreground">{c.type}</span></td>
                    <td>
                      {c.routes && c.routes.length > 0 ? (
                        <div className="flex flex-col gap-0.5">
                          {c.routes.map((r: any) => (
                            <span key={r.routeId} className="text-[12px]">
                              <span className="font-mono">{r.routeCode}</span> — {r.routeName}
                              {r.isPrimary && c.routes!.length > 1 && (
                                <span className="ml-1 text-muted-foreground text-[11px]">(primary)</span>
                              )}
                            </span>
                          ))}
                        </div>
                      ) : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td>{c.phone}</td>
                    <td>{c.payMode}</td>
                     <td><StatusPill status={c.status === "Active" ? "active" : "draft"} /></td>
                     <td style={{ textAlign: "right" }}>
                      <div className="flex items-center justify-end gap-1.5">
                        <Button variant="outline" size="sm" className="h-7 px-2.5 text-[12px]"
                                onClick={() => setViewing(c)}>View</Button>
                        <Button size="sm" className="h-7 px-2.5 text-[12px]"
                                onClick={() => setEditing(c)}>Update</Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
 
          {/* Server-side pagination footer */}
          <div className="px-3 py-2 border-t border-border bg-muted/30 text-[12px] flex items-center gap-3">
            <span className="text-muted-foreground">
              Page <span className="num font-medium">{page}</span> of <span className="num">{totalPages}</span>
            </span>
            <div className="ml-auto flex items-center gap-2">
              <span className="text-muted-foreground text-[11px]">Rows / page:</span>
              <Select value={String(pageSize)} onValueChange={v => setPageSize(Number(v))}>
                <SelectTrigger className="erp-input h-7 w-20"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {[25, 50, 100].map(n => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}
                </SelectContent>
              </Select>
              <Button variant="outline" size="sm" className="h-7 px-2"
                      disabled={page <= 1 || pageQuery.isFetching}
                      onClick={() => setPage(p => Math.max(1, p - 1))}>
                <ChevronLeft className="h-3.5 w-3.5" />
              </Button>
              <Button variant="outline" size="sm" className="h-7 px-2"
                      disabled={page >= totalPages || pageQuery.isFetching}
                      onClick={() => setPage(p => Math.min(totalPages, p + 1))}>
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        </div>
      </div>
 
      <CustomerViewDialog customer={viewing} routes={routes} onClose={() => setViewing(null)} />
      <CustomerEditDialog
        customer={editing}
        routes={routes}
        zones={zones}
        rateCategories={rateCategories}
        officers={officers}
        onClose={() => setEditing(null)}
        onSaved={() => {
          qc.invalidateQueries({ queryKey: ["customers"] });
          qc.invalidateQueries({ queryKey: ["customers-page"] });
        }}
      />
    </div>
  );
}
 
// ─────────────────────────────────────────────────────────────────
// CustomerViewDialog (unchanged from previous version)
// ─────────────────────────────────────────────────────────────────
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
          <DialogTitle className="text-[15px]">{customer.code} — {customer.name}</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-x-6 gap-y-0">
          <Row label="Code" value={<span className="font-mono">{customer.code}</span>} />
          <Row label="Status" value={<StatusPill status={customer.status === "Active" ? "active" : "draft"} />} />
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
          <Row label="Outstanding"      value={(customer as any).outstanding != null
            ? `₹${Number((customer as any).outstanding).toLocaleString("en-IN")}` : "—"} />
          <Row label="Available Balance" value={(customer as any).creditAvailable != null
            ? `₹${Number((customer as any).creditAvailable).toLocaleString("en-IN")}` : "—"} />
          <Row label="Wallet / Credit Bal." value={(customer as any).creditBalance != null
            ? `₹${Number((customer as any).creditBalance).toLocaleString("en-IN")}` : "—"} />
          <Row label="Address Type" value={(customer as any).addressType} />
          <Row label="State" value={(customer as any).state} />
          <Row label="Taluka" value={(customer as any).zoneName} />
          <Row label="District" value={(customer as any).city} />
          <Row label="Area" value={(customer as any).area} />
          <Row label="House No." value={(customer as any).houseNo} />
          <Row label="Street" value={(customer as any).street} />
          <Row label="Pin Code" value={(customer as any).pinCode} />
          <Row label="Address" value={(customer as any).address} />
          <Row label="Routes" value={
            customer.routes?.length
              ? customer.routes.map((r: any) => `${r.routeCode}${r.isPrimary ? " ★" : ""}`).join(", ")
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
  routes: any[]; zones: any[]; rateCategories: any[]; officers: any[];
  onClose: () => void; onSaved: () => void;
}) {
  if (!customer) return null;
  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-auto">
        <DialogHeader><DialogTitle>Edit Customer — {customer.code}</DialogTitle></DialogHeader>
        <CustomerFormBody
          mode="edit"
          initial={customer as any}
          routes={routes} zones={zones}
          rateCategories={rateCategories} officers={officers}
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
      addressType: initial?.addressType ?? "",
      state: initial?.state ?? "Karnataka",
      zoneId: initial?.zoneId ?? "",
      city: initial?.city ?? "",
      area: initial?.area ?? "",
      houseNo: initial?.houseNo ?? "",
      street: initial?.street ?? "",
      pinCode: (initial as any)?.pinCode ?? "",
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
  const rateCatOpts: F9Option[]  = useMemo(() => (rateCategories ?? []).map((r: any) => ({ value: r.value ?? r, label: r.label ?? r })), [rateCategories]);
  const routeOpts: F9Option[]    = useMemo(() => routes.map((r: any) => ({ value: r.id, label: r.name, sublabel: r.code })), [routes]);

  // Officer follows the taluka — auto-filled (read-only) from the selected
  // zone's assigned officer. Re-runs once zones load so edits resolve too.
  const selectedZoneId = form.watch("zoneId");
  useEffect(() => {
    if (!zones.length) return;
    const zoneOfficer = (zones.find((z: any) => z.id === selectedZoneId)?.officerName ?? "") as string;
    if (form.getValues("officerName") !== zoneOfficer) {
      form.setValue("officerName", zoneOfficer);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedZoneId, zones]);

  // Distinct cities derived from existing dealers — populated lazily.
  const { data: existingCustomers = [] } = useQuery({ queryKey: ["customers"], queryFn: fetchCustomers });
  const cityOpts: F9Option[] = useMemo(() => {
    const set = new Set<string>();
    existingCustomers.forEach((c: any) => { if (c.city) set.add(c.city); });
    return Array.from(set).sort().map(c => ({ value: c, label: c }));
  }, [existingCustomers]);

  const submit = form.handleSubmit(d => save.mutate(d));
  useSaveShortcut(() => submit(), !save.isPending);

  return (
    <form onSubmit={submit} className="space-y-3 pb-20">
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
        <Field label="Officer" hint="from taluka">
          <Input
            className="erp-input bg-muted"
            value={form.watch("officerName") || ""}
            readOnly
            placeholder="Set by taluka"
          />
        </Field>
        <Field label="Bank">
          <Input className="erp-input" {...form.register("bank")} />
        </Field>
        <Field label="Account No.">
          <Input className="erp-input" {...form.register("accountNo")} />
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
        <Field label="District" hint="F9">
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
        <Field label="Pin Code">
          <Input
            className="erp-input"
            {...form.register("pinCode")}
            placeholder="e.g. 581110"
            maxLength={6}
            inputMode="numeric"
          />
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