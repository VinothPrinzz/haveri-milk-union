// apps/web/src/pages/masters/OfficersPage.tsx
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus, Save, X, MapPin } from "lucide-react";
import PageHeader, {
  FormSection, Field, FormFooter, StatusPill,
} from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  fetchOfficers, fetchZones, createOfficer, updateOfficer,
  type Officer,
} from "@/services/api";
import { useSaveShortcut } from "@/lib/useKeyboardNav";

interface Props { tab?: "list" | "new"; }

interface OfficerFormValues {
  name: string;
  phone: string;
  active: boolean;
  talukaIds: string[];
}

// ─── Shared form body (create + edit) ─────────────────────────────────
function OfficerFormBody({
  initialData, onSubmit, isSubmitting, onCancel, embedded,
}: {
  initialData?: Officer;
  onSubmit: (data: OfficerFormValues) => void | Promise<void>;
  isSubmitting?: boolean;
  onCancel?: () => void;
  embedded?: boolean;
}) {
  const isEdit = Boolean(initialData);
  const { data: zones = [] } = useQuery({ queryKey: ["zones"], queryFn: fetchZones });

  const [name, setName] = useState(initialData?.name ?? "");
  const [phone, setPhone] = useState(initialData?.phone ?? "");
  const [active, setActive] = useState(initialData?.active ?? true);
  const [talukaIds, setTalukaIds] = useState<string[]>(
    initialData?.talukas.map(t => t.id) ?? [],
  );

  const toggleTaluka = (id: string) =>
    setTalukaIds(prev => prev.includes(id) ? prev.filter(t => t !== id) : [...prev, id]);

  const submit = async () => {
    if (!name.trim()) return toast.error("Officer name is required");
    try {
      await onSubmit({ name: name.trim(), phone: phone.trim(), active, talukaIds });
    } catch (e) {
      toast.error((e as Error)?.message || "Failed to save");
    }
  };

  useSaveShortcut(() => submit(), !isSubmitting);

  const Wrap = embedded
    ? ({ children }: { children: React.ReactNode }) => <div>{children}</div>
    : ({ children }: { children: React.ReactNode }) => <div className="p-4">{children}</div>;

  return (
    <Wrap>
      <form onSubmit={e => { e.preventDefault(); submit(); }}>
        <FormSection title="Officer Details" cols={2}>
          <Field label="Officer Name" required>
            <Input
              className="erp-input"
              placeholder="e.g. Sachin Haramagatti"
              value={name}
              onChange={e => setName(e.target.value)}
            />
          </Field>
          <Field label="Phone" hint="Optional">
            <Input
              className="erp-input"
              placeholder="10-digit mobile"
              value={phone}
              onChange={e => setPhone(e.target.value)}
            />
          </Field>
          <Field label="Active">
            <div className="flex items-center gap-3 h-9">
              <Switch checked={active} onCheckedChange={setActive} />
              <span className="text-[13px]">{active ? "Active" : "Inactive"}</span>
            </div>
          </Field>
        </FormSection>

        <FormSection title="Assigned Talukas" cols={1}>
          <div className="text-[11.5px] text-muted-foreground -mt-1 mb-1">
            Select the talukas this officer covers. A taluka is assigned to only
            one officer — selecting it here reassigns it from any current officer.
          </div>
          {zones.length === 0 ? (
            <div className="text-[13px] text-muted-foreground py-2">No talukas configured.</div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
              {zones.map(z => {
                const checked = talukaIds.includes(z.id);
                const takenBy = z.officerName && !initialData?.talukas.some(t => t.id === z.id)
                  ? z.officerName
                  : "";
                return (
                  <label
                    key={z.id}
                    className="flex items-center gap-2.5 px-2.5 py-2 rounded-sm border border-border hover:bg-accent/50 cursor-pointer"
                  >
                    <Checkbox checked={checked} onCheckedChange={() => toggleTaluka(z.id)} />
                    <span className="min-w-0">
                      <span className="text-[13px] font-medium block truncate">{z.name}</span>
                      {takenBy && (
                        <span className="text-[10.5px] text-muted-foreground block truncate">
                          currently: {takenBy}
                        </span>
                      )}
                    </span>
                  </label>
                );
              })}
            </div>
          )}
        </FormSection>

        {embedded ? (
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" size="sm" className="h-8" onClick={onCancel}>
              <X className="w-3.5 h-3.5 mr-1.5" /> Cancel
            </Button>
            <Button type="submit" size="sm" className="h-8 bg-primary hover:bg-primary-hover" disabled={isSubmitting}>
              <Save className="w-3.5 h-3.5 mr-1.5" /> {isSubmitting ? "Saving…" : (isEdit ? "Update" : "Save")}
            </Button>
          </div>
        ) : (
          <FormFooter>
            <Button type="submit" size="sm" className="h-8 bg-primary hover:bg-primary-hover" disabled={isSubmitting}>
              {isSubmitting ? "Saving…" : "Save Officer"}
            </Button>
          </FormFooter>
        )}
      </form>
    </Wrap>
  );
}

// ─── Talukas chips (list + view) ──────────────────────────────────────
function TalukaChips({ talukas }: { talukas: Officer["talukas"] }) {
  if (talukas.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {talukas.map(t => (
        <span
          key={t.id}
          className="text-[11px] px-1.5 py-0.5 rounded bg-secondary text-secondary-foreground"
        >
          {t.name}
        </span>
      ))}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────
export default function OfficersPage({ tab = "list" }: Props) {
  const qc = useQueryClient();
  const { data: officers = [], isLoading } = useQuery({ queryKey: ["officers"], queryFn: fetchOfficers });

  const [editing, setEditing] = useState<Officer | null>(null);
  const [viewing, setViewing] = useState<Officer | null>(null);

  const sortedOfficers = useMemo(
    () => [...officers].sort((a, b) => a.name.localeCompare(b.name)),
    [officers],
  );

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["officers"] });
    qc.invalidateQueries({ queryKey: ["zones"] });
  };

  const createMutation = useMutation({
    mutationFn: createOfficer,
    onSuccess: () => { invalidate(); toast.success("Officer saved"); },
    onError: (err: Error) => toast.error(err.message),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: OfficerFormValues }) => updateOfficer(id, data),
    onSuccess: () => { invalidate(); toast.success("Officer updated"); },
    onError: (err: Error) => toast.error(err.message),
  });

  // ─── New tab ───────────────────────────────────────────────────
  if (tab === "new") {
    return (
      <div>
        <PageHeader title="New Officer" subtitle="Add a field sales officer and assign talukas" />
        <OfficerFormBody
          onSubmit={async d => { await createMutation.mutateAsync(d); }}
          isSubmitting={createMutation.isPending}
        />
      </div>
    );
  }

  // ─── List tab ──────────────────────────────────────────────────
  return (
    <div>
      <PageHeader
        title="All Officers"
        subtitle={`${officers.length} officer(s) configured`}
        actions={
          <Button size="sm" className="h-8 bg-primary hover:bg-primary-hover" asChild>
            <a href="/masters/officers/new"><Plus className="w-3.5 h-3.5 mr-1.5" />New Officer</a>
          </Button>
        }
      />
      <div className="p-4">
        <div className="erp-panel overflow-hidden">
          <div className="overflow-auto max-h-[calc(100vh-220px)]">
            <table className="erp-table">
              <thead>
                <tr>
                  <th>Officer Name</th>
                  <th>Phone</th>
                  <th>Assigned Talukas</th>
                  <th>Status</th>
                  <th style={{ textAlign: "center", width: "150px" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {isLoading && Array.from({ length: 5 }).map((_, i) => (
                  <tr key={`s-${i}`} className={i % 2 === 1 ? "zebra" : ""}>
                    {Array.from({ length: 5 }).map((_, j) => (
                      <td key={j}><Skeleton className="h-3.5 w-full" /></td>
                    ))}
                  </tr>
                ))}
                {!isLoading && sortedOfficers.map((o, i) => (
                  <tr key={o.id} className={i % 2 === 1 ? "zebra" : ""}>
                    <td className="font-medium">{o.name}</td>
                    <td>{o.phone || <span className="text-muted-foreground">—</span>}</td>
                    <td><TalukaChips talukas={o.talukas} /></td>
                    <td><StatusPill status={o.active ? "active" : "draft"} /></td>
                    <td style={{ textAlign: "center" }}>
                      <div className="flex items-center justify-center gap-1.5">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 px-2.5 text-[12px]"
                          onClick={() => setViewing(o)}
                        >
                          View
                        </Button>
                        <Button
                          size="sm"
                          className="h-7 px-2.5 text-[12px]"
                          onClick={() => setEditing(o)}
                        >
                          Update
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
                {!isLoading && officers.length === 0 && (
                  <tr><td colSpan={5} className="py-8 text-center text-muted-foreground">No officers configured yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Edit dialog */}
      <Dialog open={!!editing} onOpenChange={open => !open && setEditing(null)}>
        <DialogContent className="max-w-3xl rounded-sm max-h-[85vh] overflow-auto">
          <DialogHeader>
            <DialogTitle className="text-[15px] font-semibold">Edit Officer — {editing?.name}</DialogTitle>
          </DialogHeader>
          {editing && (
            <OfficerFormBody
              embedded
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

      {/* View dialog */}
      <Dialog open={!!viewing} onOpenChange={o => !o && setViewing(null)}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-auto">
          <DialogHeader>
            <DialogTitle>{viewing?.name}</DialogTitle>
          </DialogHeader>
          {viewing && (() => {
            const Row = ({ label, value }: { label: string; value: React.ReactNode }) => (
              <div className="flex items-baseline gap-2 py-1 border-b border-border/60 last:border-0">
                <span className="text-[11px] uppercase tracking-wide text-muted-foreground w-32 shrink-0">{label}</span>
                <span className="text-[13px] font-medium">{value || <span className="text-muted-foreground">—</span>}</span>
              </div>
            );
            return (
              <>
                <div className="grid grid-cols-2 gap-x-6">
                  <Row label="Name" value={viewing.name} />
                  <Row label="Status" value={<StatusPill status={viewing.active ? "active" : "draft"} />} />
                  <Row label="Phone" value={viewing.phone} />
                  <Row label="Talukas" value={viewing.talukas.length} />
                </div>
                <div className="erp-panel mt-4">
                  <div className="px-3 py-2 erp-section-title !mb-0 !border-b !pb-2 flex items-center justify-between">
                    <span>Talukas Covered</span>
                    <span className="text-[11px] normal-case font-normal text-muted-foreground num">{viewing.talukas.length}</span>
                  </div>
                  <div className="p-3">
                    {viewing.talukas.length === 0 ? (
                      <div className="text-center text-muted-foreground py-6 text-[13px]">
                        No talukas assigned to this officer.
                      </div>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {viewing.talukas.map(t => (
                          <span
                            key={t.id}
                            className="inline-flex items-center gap-1.5 text-[12.5px] px-2 py-1 rounded-sm bg-secondary text-secondary-foreground"
                          >
                            <MapPin className="w-3 h-3" /> {t.name}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </>
            );
          })()}
          <DialogFooter className="gap-2">
            <Button variant="outline" size="sm" onClick={() => setViewing(null)}>Close</Button>
            {viewing && (
              <Button
                size="sm"
                className="bg-primary hover:bg-primary-hover"
                onClick={() => { setEditing(viewing); setViewing(null); }}
              >
                Update
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
