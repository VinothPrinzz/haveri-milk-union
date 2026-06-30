import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import PageHeader, { FilterBar, Field, EmptyState, fmtDate, StatusPill } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Plus, Pencil, Trash2, Search } from "lucide-react";
import {
  fetchEmployees, createEmployee, updateEmployee, deleteEmployee,
  fetchEmployeeSubsidyRules, createEmployeeSubsidyRule,
  updateEmployeeSubsidyRule, deleteEmployeeSubsidyRule,
  fetchProducts,
} from "@/services/api";

type Emp = {
  id: string; employee_code?: string | null; name: string;
  phone?: string | null; department?: string | null; designation?: string | null;
  active: boolean; created_at?: string;
};

const empty = { employeeCode: "", name: "", phone: "", department: "", designation: "", active: true };

export default function EmployeesPage() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [activeOnly, setActiveOnly] = useState(true);

  const { data: emps = [], isLoading } = useQuery({
    queryKey: ["employees", search, activeOnly],
    queryFn: () => fetchEmployees({ search: search || undefined, activeOnly }),
  });

  const [openNew, setOpenNew] = useState(false);
  const [form, setForm] = useState(empty);
  const [editing, setEditing] = useState<Emp | null>(null);

  const createMut = useMutation({
    mutationFn: () => createEmployee({
      employeeCode: form.employeeCode.trim() || undefined,
      name: form.name.trim(),
      phone: form.phone.trim() || undefined,
      department: form.department.trim() || undefined,
      designation: form.designation.trim() || undefined,
      active: form.active,
    }),
    onSuccess: () => {
      toast.success("Employee added");
      qc.invalidateQueries({ queryKey: ["employees"] });
      setOpenNew(false); setForm(empty);
    },
    onError: (e: any) => toast.error(e?.message || "Failed"),
  });

  const updateMut = useMutation({
    mutationFn: () => updateEmployee(editing!.id, {
      employeeCode: editing!.employee_code, name: editing!.name,
      phone: editing!.phone, department: editing!.department,
      designation: editing!.designation, active: editing!.active,
    }),
    onSuccess: () => {
      toast.success("Employee updated");
      qc.invalidateQueries({ queryKey: ["employees"] });
      setEditing(null);
    },
    onError: (e: any) => toast.error(e?.message || "Failed"),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteEmployee(id),
    onSuccess: () => {
      toast.success("Employee deleted");
      qc.invalidateQueries({ queryKey: ["employees"] });
    },
    onError: (e: any) => toast.error(e?.message || "Failed"),
  });

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Employees"
        subtitle={`${(emps as Emp[]).length} employee(s)`}
        actions={
          <Button size="sm" className="h-8" onClick={() => setOpenNew(true)}>
            <Plus className="h-3.5 w-3.5 mr-1" /> New Employee
          </Button>
        }
      />

      <FilterBar>
        <Field label="Search">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="Name, code or phone…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="erp-input pl-8 w-64"
            />
          </div>
        </Field>
        <Field label="Active only">
          <Switch checked={activeOnly} onCheckedChange={setActiveOnly} />
        </Field>
      </FilterBar>

      {/* Editable employee subsidy prices (GST-inclusive fixed price per product) */}
      <SubsidyRulesPanel />

      <div className="flex-1 overflow-auto p-3">
        <div className="erp-panel overflow-hidden">
          {isLoading ? (
            <div className="p-3 space-y-2">
              {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}
            </div>
          ) : (emps as Emp[]).length === 0 ? (
            <EmptyState title="No employees" hint="Add the first one with the button above." />
          ) : (
            <table className="erp-table w-full">
              <thead>
                <tr>
                  <th>Code</th><th>Name</th><th>Phone</th>
                  <th>Department</th><th>Designation</th><th>Status</th>
                  <th>Added</th>
                  <th style={{ textAlign: "right" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {(emps as Emp[]).map(e => (
                  <tr key={e.id}>
                    <td className="font-mono text-[12px]">{e.employee_code || "—"}</td>
                    <td className="font-medium">{e.name}</td>
                    <td>{e.phone || "—"}</td>
                    <td>{e.department || "—"}</td>
                    <td>{e.designation || "—"}</td>
                    <td><StatusPill status={e.active ? "Active" : "Inactive"} /></td>
                    <td>{e.created_at ? fmtDate(e.created_at) : "—"}</td>
                    <td style={{ textAlign: "right" }}>
                      <Button variant="outline" size="sm" className="h-7 px-2" onClick={() => setEditing(e)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 px-2 ml-1 text-destructive"
                        onClick={() => {
                          if (confirm(`Delete employee "${e.name}"?`)) deleteMut.mutate(e.id);
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* New */}
      <Dialog open={openNew} onOpenChange={setOpenNew}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>New Employee</DialogTitle></DialogHeader>
          <div className="space-y-3 p-1">
            <Field label="Code">
              <Input className="erp-input" value={form.employeeCode}
                     onChange={e => setForm(f => ({ ...f, employeeCode: e.target.value }))} placeholder="e.g. EMP-042" />
            </Field>
            <Field label="Name" required>
              <Input className="erp-input" value={form.name} autoFocus
                     onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
            </Field>
            <Field label="Phone">
              <Input className="erp-input" value={form.phone} maxLength={10}
                     onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} />
            </Field>
            <Field label="Department">
              <Input className="erp-input" value={form.department}
                     onChange={e => setForm(f => ({ ...f, department: e.target.value }))} />
            </Field>
            <Field label="Designation">
              <Input className="erp-input" value={form.designation}
                     onChange={e => setForm(f => ({ ...f, designation: e.target.value }))} />
            </Field>
            <Field label="Active">
              <Switch checked={form.active} onCheckedChange={v => setForm(f => ({ ...f, active: v }))} />
            </Field>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setOpenNew(false)}>Cancel</Button>
            <Button size="sm" disabled={!form.name.trim() || createMut.isPending} onClick={() => createMut.mutate()}>
              {createMut.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit */}
      <Dialog open={!!editing} onOpenChange={o => !o && setEditing(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Edit Employee</DialogTitle></DialogHeader>
          {editing && (
            <div className="space-y-3 p-1">
              <Field label="Code">
                <Input className="erp-input" value={editing.employee_code ?? ""}
                       onChange={e => setEditing({ ...editing, employee_code: e.target.value })} />
              </Field>
              <Field label="Name" required>
                <Input className="erp-input" value={editing.name}
                       onChange={e => setEditing({ ...editing, name: e.target.value })} />
              </Field>
              <Field label="Phone">
                <Input className="erp-input" value={editing.phone ?? ""} maxLength={10}
                       onChange={e => setEditing({ ...editing, phone: e.target.value })} />
              </Field>
              <Field label="Department">
                <Input className="erp-input" value={editing.department ?? ""}
                       onChange={e => setEditing({ ...editing, department: e.target.value })} />
              </Field>
              <Field label="Designation">
                <Input className="erp-input" value={editing.designation ?? ""}
                       onChange={e => setEditing({ ...editing, designation: e.target.value })} />
              </Field>
              <Field label="Active">
                <Switch checked={editing.active} onCheckedChange={v => setEditing({ ...editing, active: v })} />
              </Field>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setEditing(null)}>Cancel</Button>
            <Button size="sm" disabled={!editing?.name.trim() || updateMut.isPending} onClick={() => updateMut.mutate()}>
              {updateMut.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
// Employee Subsidy Prices — editable, GST-inclusive fixed price per product
// ════════════════════════════════════════════════════════════════════
function SubsidyRulesPanel() {
  const qc = useQueryClient();
  const { data: rules = [], isLoading } = useQuery({
    queryKey: ["emp-subsidy-rules"], queryFn: fetchEmployeeSubsidyRules,
  });

  // Per-row price edit buffer (rule id → input string). Falls back to saved value.
  const [draft, setDraft] = useState<Record<string, string>>({});
  const priceStr = (id: string, saved: number) => draft[id] ?? saved.toFixed(2);

  const [addOpen, setAddOpen] = useState(false);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["emp-subsidy-rules"] });

  const saveMut = useMutation({
    mutationFn: ({ id, subsidyPrice }: { id: string; subsidyPrice: number }) =>
      updateEmployeeSubsidyRule(id, { subsidyPrice }),
    onSuccess: (_d, v) => {
      toast.success("Employee price updated");
      setDraft(d => { const { [v.id]: _omit, ...rest } = d; return rest; });
      invalidate();
    },
    onError: (e: any) => toast.error(e?.message || "Failed"),
  });

  const removeMut = useMutation({
    mutationFn: (id: string) => deleteEmployeeSubsidyRule(id),
    onSuccess: () => { toast.success("Product removed from subsidy list"); invalidate(); },
    onError: (e: any) => toast.error(e?.message || "Failed"),
  });

  return (
    <div className="mx-3 mb-2 erp-panel overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b">
        <div className="text-[12px] font-semibold">
          Employee Subsidy Prices
          <span className="ml-2 font-normal text-muted-foreground">
            Fixed price the employee pays per unit (GST-inclusive)
          </span>
        </div>
        <Button size="sm" variant="outline" className="h-7" onClick={() => setAddOpen(true)}>
          <Plus className="h-3.5 w-3.5 mr-1" /> Add product
        </Button>
      </div>

      {isLoading ? (
        <div className="p-3"><Skeleton className="h-8 w-full" /></div>
      ) : rules.length === 0 ? (
        <div className="p-3 text-[12px] text-muted-foreground">
          No subsidy products yet. Use “Add product” to set an employee price.
        </div>
      ) : (
        <table className="erp-table w-full">
          <thead>
            <tr>
              <th>Product</th><th>Unit</th>
              <th style={{ textAlign: "right" }}>MRP</th>
              <th style={{ textAlign: "right" }}>GST %</th>
              <th style={{ textAlign: "right" }}>Employee price (incl. GST)</th>
              <th style={{ textAlign: "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rules.map(r => {
              const dirty =
                draft[r.id] !== undefined && parseFloat(draft[r.id]) !== r.subsidyPrice;
              return (
                <tr key={r.id}>
                  <td className="font-medium">{r.productName}</td>
                  <td>{r.unit || "—"}</td>
                  <td className="text-right num">₹{r.basePrice.toFixed(2)}</td>
                  <td className="text-right num">{r.gstPercent}%</td>
                  <td style={{ textAlign: "right" }}>
                    <Input
                      type="number" min={0} step="0.01"
                      className="erp-input num h-7 w-28 ml-auto"
                      value={priceStr(r.id, r.subsidyPrice)}
                      onChange={e => setDraft(d => ({ ...d, [r.id]: e.target.value }))}
                    />
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <Button
                      size="sm" className="h-7 px-2"
                      disabled={!dirty || saveMut.isPending}
                      onClick={() => {
                        const v = parseFloat(draft[r.id]);
                        if (!isFinite(v) || v < 0) { toast.error("Enter a valid price"); return; }
                        saveMut.mutate({ id: r.id, subsidyPrice: +v.toFixed(2) });
                      }}
                    >
                      Save
                    </Button>
                    <Button
                      variant="outline" size="sm" className="h-7 px-2 ml-1 text-destructive"
                      onClick={() => {
                        if (confirm(`Remove "${r.productName}" from the employee subsidy list?`))
                          removeMut.mutate(r.id);
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <AddSubsidyRuleDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        existingProductIds={rules.map(r => r.productId)}
        onSaved={() => { setAddOpen(false); invalidate(); }}
      />
    </div>
  );
}

function AddSubsidyRuleDialog({
  open, onOpenChange, existingProductIds, onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  existingProductIds: string[];
  onSaved: () => void;
}) {
  const { data: products = [] } = useQuery({
    queryKey: ["products-for-subsidy"], queryFn: fetchProducts, enabled: open,
  });
  const [productId, setProductId] = useState("");
  const [price, setPrice] = useState("");

  const options = (products as Array<{ id: string; name: string; unit: string }>)
    .filter(p => !existingProductIds.includes(p.id));

  const addMut = useMutation({
    mutationFn: () =>
      createEmployeeSubsidyRule({ productId, subsidyPrice: +parseFloat(price).toFixed(2) }),
    onSuccess: () => {
      toast.success("Product added to subsidy list");
      setProductId(""); setPrice("");
      onSaved();
    },
    onError: (e: any) => toast.error(e?.message || "Failed"),
  });

  const priceNum = parseFloat(price);
  const valid = !!productId && isFinite(priceNum) && priceNum >= 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Add Subsidy Product</DialogTitle></DialogHeader>
        <div className="space-y-3 p-1">
          <Field label="Product" required>
            <Select value={productId} onValueChange={setProductId}>
              <SelectTrigger className="erp-input">
                <SelectValue placeholder="Select a product" />
              </SelectTrigger>
              <SelectContent>
                {options.length === 0 ? (
                  <div className="px-2 py-1.5 text-[12px] text-muted-foreground">
                    All products already have a rule
                  </div>
                ) : options.map(p => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}{p.unit ? ` (${p.unit})` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Employee price / unit (incl. GST)" required>
            <Input
              type="number" min={0} step="0.01" className="erp-input num"
              value={price} onChange={e => setPrice(e.target.value)}
              placeholder="e.g. 150.00"
            />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button size="sm" disabled={!valid || addMut.isPending} onClick={() => addMut.mutate()}>
            {addMut.isPending ? "Saving…" : "Add"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}