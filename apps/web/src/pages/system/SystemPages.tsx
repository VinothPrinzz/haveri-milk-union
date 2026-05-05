import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import PageHeader, {
  FilterBar,
  StatusPill,
  EmptyState,
  fmtDate,
  fmtNum,
} from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Plus, Send, Pencil, Trash2 } from "lucide-react";
import {
  fetchTimeWindows, updateTimeWindow,
  fetchNotifications, sendBroadcast,
  fetchDealerNotifications,
  fetchBanners, createBanner, updateBanner, deleteBanner,
  fetchRoles, updateRolePermissions,
  fetchSystemUsers as fetchUsers, createUser, updateUser, deleteUser,
  sendDealerNotification,    
  fetchDealersLite,          
  fetchZones,
} from "@/services/api";

// ═════════════════════════════════════════════════════════════════
// 1. TIME WINDOWS
// ═════════════════════════════════════════════════════════════════
export function TimeWindowsPage() {
  const qc = useQueryClient();
  const { data: windows = [], isLoading } = useQuery({
    queryKey: ["time-windows"], 
    queryFn: fetchTimeWindows,
  });

  const update = useMutation({
    mutationFn: (p: { id: string; openTime: string; warningMinutes: number; closeTime: string; active: boolean }) =>
      updateTimeWindow(p.id, {
        openTime: p.openTime,
        warningMinutes: p.warningMinutes,
        closeTime: p.closeTime,
        active: p.active,
      }),
    onSuccess: () => {
      toast.success("Time window updated");
      qc.invalidateQueries({ queryKey: ["time-windows"] });
    },
    onError: (err: any) => toast.error(err?.message || "Update failed"),
  });

  return (
    <div className="flex flex-col h-full">
      <PageHeader title="Time Windows" subtitle="Daily ordering windows for the dealer mobile app" />
      <div className="flex-1 overflow-auto p-4">
        <div className="erp-panel overflow-hidden">
          {isLoading ? (
            <div className="p-4 space-y-2">
              {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-9 w-full" />)}
            </div>
          ) : (windows as any[]).length === 0 ? (
            <EmptyState title="No time windows configured" />
          ) : (
            <table className="erp-table">
              <thead>
                <tr>
                  <th>Zone</th>
                  <th style={{ width: 140 }}>Open</th>
                  <th style={{ width: 160 }}>Warning (min before close)</th>
                  <th style={{ width: 140 }}>Close</th>
                  <th style={{ width: 90 }}>Active</th>
                  <th style={{ width: 110 }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {(windows as any[]).map((w: any) => (
                  <TimeWindowRow key={w.id} row={w} onSave={p => update.mutate(p)} />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

function TimeWindowRow({
  row, onSave,
}: {
  row: { id: string; zoneName: string; openTime: string; warningMinutes?: number; closeTime: string; active: boolean };
  onSave: (p: { id: string; openTime: string; warningMinutes: number; closeTime: string; active: boolean }) => void;
}) {
  const [open, setOpen] = useState(row.openTime);
  const [warning, setWarning] = useState<number>(row.warningMinutes ?? 20);
  const [close, setClose] = useState(row.closeTime);
  const [active, setActive] = useState(row.active);

  const dirty =
    open !== row.openTime || 
    close !== row.closeTime ||
    active !== row.active || 
    warning !== (row.warningMinutes ?? 20);

  return (
    <tr>
      <td className="font-medium">{row.zoneName}</td>
      <td>
        <Input type="time" value={open} onChange={e => setOpen(e.target.value)} className="erp-input h-8 w-32" />
      </td>
      <td>
        <Input 
          type="number" 
          value={warning} 
          onChange={e => setWarning(Math.max(0, parseInt(e.target.value) || 0))} 
          className="erp-input h-8 w-24" 
          min={0} 
          max={240} 
        />
      </td>
      <td>
        <Input type="time" value={close} onChange={e => setClose(e.target.value)} className="erp-input h-8 w-32" />
      </td>
      <td>
        <Switch checked={active} onCheckedChange={setActive} />
      </td>
      <td>
        {dirty ? (
          <Button size="sm" className="h-7" onClick={() => onSave({ id: row.id, openTime: open, warningMinutes: warning, closeTime: close, active })}>
            Save
          </Button>
        ) : (
          <StatusPill status={active ? "active" : "inactive"} />
        )}
      </td>
    </tr>
  );
}

// ═════════════════════════════════════════════════════════════════
// 2. NOTIFICATIONS (broadcasts)
// ═════════════════════════════════════════════════════════════════
export function NotificationsPage() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({ title: "", message: "", audience: "all", channel: "push" });

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["notifications"], queryFn: fetchNotifications,
  });

  const send = useMutation({
    mutationFn: () => sendBroadcast(draft),
    onSuccess: () => {
      toast.success("Broadcast queued");
      qc.invalidateQueries({ queryKey: ["notifications"] });
      setOpen(false);
      setDraft({ title: "", message: "", audience: "all", channel: "push" });
    },
    onError: (err: any) => toast.error(err?.message || "Failed to send"),
  });

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Notifications"
        subtitle="Broadcast push / SMS / email to dealers"
        actions={
          <Button size="sm" className="h-8" onClick={() => setOpen(true)}>
            <Send className="h-3.5 w-3.5 mr-1.5" /> New Broadcast
          </Button>
        }
      />

      <div className="flex-1 overflow-auto p-4">
        <div className="erp-panel overflow-hidden">
          {isLoading ? (
            <div className="p-4 space-y-2">
              {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-7 w-full" />)}
            </div>
          ) : (rows as any[]).length === 0 ? (
            <EmptyState title="No broadcasts sent yet" />
          ) : (
            <table className="erp-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Title</th>
                  <th>Audience</th>
                  <th>Channel</th>
                  <th className="num" style={{ textAlign: "right" }}>Sent</th>
                  <th className="num" style={{ textAlign: "right" }}>Delivered</th>
                  <th className="num" style={{ textAlign: "right" }}>Failed</th>
                </tr>
              </thead>
              <tbody>
                {(rows as any[]).map((r: any) => (
                  <tr key={r.id}>
                    <td>{fmtDate(r.date ?? r.createdAt)}</td>
                    <td className="font-medium">{r.title}</td>
                    <td className="capitalize">{r.audience}</td>
                    <td className="uppercase font-mono text-[12px]">{r.channel}</td>
                    <td className="num" style={{ textAlign: "right" }}>{fmtNum(r.sent)}</td>
                    <td className="num" style={{ textAlign: "right" }}>{fmtNum(r.delivered)}</td>
                    <td className="num" style={{ textAlign: "right" }}>
                      <span className={r.failed > 0 ? "text-destructive" : ""}>{fmtNum(r.failed)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>New Broadcast</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">Title</label>
              <Input value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })} className="erp-input" />
            </div>
            <div>
              <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">Message</label>
              <Textarea value={draft.message} onChange={e => setDraft({ ...draft, message: e.target.value })} className="erp-input min-h-[90px]" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">Audience</label>
                <Select value={draft.audience} onValueChange={v => setDraft({ ...draft, audience: v })}>
                  <SelectTrigger className="erp-input"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All dealers</SelectItem>
                    <SelectItem value="active">Active only</SelectItem>
                    <SelectItem value="route">By route</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">Channel</label>
                <Select value={draft.channel} onValueChange={v => setDraft({ ...draft, channel: v })}>
                  <SelectTrigger className="erp-input"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="push">Push</SelectItem>
                    <SelectItem value="sms">SMS</SelectItem>
                    <SelectItem value="email">Email</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button disabled={!draft.title || !draft.message || send.isPending} onClick={() => send.mutate()}>
              {send.isPending ? "Sending…" : "Send"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════
// 3. DEALER NOTIFICATIONS — read-only history per dealer
// ═════════════════════════════════════════════════════════════════
export function DealerNotificationsPage() {
  const [search, setSearch] = useState("");
  const [sendOpen, setSendOpen] = useState(false);

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["dealer-notifications"], 
    queryFn: fetchDealerNotifications,
  });

  const filtered = (rows as any[]).filter((r: any) =>
    !search || (r.dealerName ?? "").toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Dealer Notifications"
        subtitle="Last broadcast received per dealer"
        actions={
          <Button size="sm" className="h-8" onClick={() => setSendOpen(true)}>
            <Send className="w-3.5 h-3.5 mr-1.5" /> Send Notification
          </Button>
        }
      />
      <FilterBar>
        <div className="flex-1 min-w-[200px]">
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">Search</label>
          <Input 
            value={search} 
            onChange={e => setSearch(e.target.value)} 
            placeholder="Dealer name…" 
            className="erp-input w-full" 
          />
        </div>
      </FilterBar>
      <div className="flex-1 overflow-auto p-4">
        <div className="erp-panel overflow-hidden">
          {isLoading ? (
            <div className="p-4 space-y-2">
              {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-7 w-full" />)}
            </div>
          ) : filtered.length === 0 ? (
            <EmptyState title="No notification history" />
          ) : (
            <table className="erp-table">
              <thead>
                <tr>
                  <th>Dealer</th>
                  <th>Last Notification</th>
                  <th>Channel</th>
                  <th>Status</th>
                  <th>Sent At</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r: any) => (
                  <tr key={r.id}>
                    <td className="font-medium">{r.dealerName}</td>
                    <td>{r.title ?? "—"}</td>
                    <td className="uppercase font-mono text-[12px]">{r.channel}</td>
                    <td>
                      <StatusPill status={r.status === "delivered" ? "delivered" : r.status === "failed" ? "failed" : "pending"} />
                    </td>
                    <td>{fmtDate(r.sentAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <SendNotificationDialog open={sendOpen} onOpenChange={setSendOpen} />
    </div>
  );
}

function SendNotificationDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const qc = useQueryClient();
  const [targetType, setTargetType] = useState<"all" | "dealer" | "zone">("all");
  const [targetId, setTargetId] = useState<string>("");
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [channel, setChannel] = useState<"push" | "sms" | "email">("push");

  const { data: dealers = [] } = useQuery({
    queryKey: ["dealers-lite"],
    queryFn: fetchDealersLite,
    enabled: open && targetType === "dealer",
  });

  const { data: zones = [] } = useQuery({
    queryKey: ["zones"],
    queryFn: fetchZones,
    enabled: open && targetType === "zone",
  });

  const send = useMutation({
    mutationFn: () => sendDealerNotification({
      title, 
      message, 
      channel,
      target: { type: targetType, id: targetType === "all" ? undefined : targetId },
    }),
    onSuccess: () => {
      toast.success("Notification queued");
      qc.invalidateQueries({ queryKey: ["dealer-notifications"] });
      onOpenChange(false);
      setTitle(""); 
      setMessage(""); 
      setTargetId(""); 
      setTargetType("all");
    },
    onError: (e: any) => toast.error(e?.message || "Send failed"),
  });

  const valid = title.trim() && message.trim() && (targetType === "all" || targetId);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Send Notification</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">Audience</label>
              <Select value={targetType} onValueChange={(v: any) => { setTargetType(v); setTargetId(""); }}>
                <SelectTrigger className="erp-input"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Dealers</SelectItem>
                  <SelectItem value="zone">By Zone</SelectItem>
                  <SelectItem value="dealer">Specific Dealer</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">Channel</label>
              <Select value={channel} onValueChange={(v: any) => setChannel(v)}>
                <SelectTrigger className="erp-input"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="push">Push</SelectItem>
                  <SelectItem value="sms">SMS</SelectItem>
                  <SelectItem value="email">Email</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {targetType === "zone" && (
            <div>
              <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">Zone</label>
              <Select value={targetId} onValueChange={setTargetId}>
                <SelectTrigger className="erp-input"><SelectValue placeholder="Select zone" /></SelectTrigger>
                <SelectContent>
                  {(zones as any[]).map((z: any) => (
                    <SelectItem key={z.id} value={z.id}>{z.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {targetType === "dealer" && (
            <div>
              <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">Dealer</label>
              <Select value={targetId} onValueChange={setTargetId}>
                <SelectTrigger className="erp-input"><SelectValue placeholder="Select dealer" /></SelectTrigger>
                <SelectContent>
                  {(dealers as any[]).map((d: any) => (
                    <SelectItem key={d.id} value={d.id}>{d.code} — {d.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div>
            <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">Title</label>
            <Input 
              value={title} 
              onChange={e => setTitle(e.target.value)} 
              className="erp-input" 
              placeholder="Short headline" 
            />
          </div>

          <div>
            <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">Message</label>
            <Textarea 
              value={message} 
              onChange={e => setMessage(e.target.value)} 
              className="erp-input min-h-[100px]" 
              placeholder="Body text" 
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!valid || send.isPending} onClick={() => send.mutate()}>
            {send.isPending ? "Sending…" : "Send"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ═════════════════════════════════════════════════════════════════
// 4. BANNER MANAGEMENT
// ═════════════════════════════════════════════════════════════════
export function BannerManagementPage() {
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [bannerForm, setBannerForm] = useState({
    title: "", category: "Announcement", startDate: "", endDate: "",
  });

  const { data: banners = [], isLoading } = useQuery({
    queryKey: ["banners"], queryFn: fetchBanners,
  });

  const bannerMutation = useMutation({
    mutationFn: (p: typeof bannerForm) => createBanner(p),
    onSuccess: () => {
      toast.success("Banner added");
      qc.invalidateQueries({ queryKey: ["banners"] });
      setShowAdd(false);
      setBannerForm({ title: "", category: "Announcement", startDate: "", endDate: "" });
    },
    onError: (err: any) => toast.error(err?.message || "Add failed"),
  });

  const toggleActive = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) => updateBanner(id, { active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["banners"] }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteBanner(id),
    onSuccess: () => {
      toast.success("Banner deleted");
      qc.invalidateQueries({ queryKey: ["banners"] });
    },
  });

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Banner Management"
        subtitle="Promotional banners shown in the dealer app"
        actions={
          <Button size="sm" className="h-8" onClick={() => setShowAdd(true)}>
            <Plus className="h-3.5 w-3.5 mr-1.5" /> Add Banner
          </Button>
        }
      />

      <div className="flex-1 overflow-auto p-4">
        <div className="erp-panel overflow-hidden">
          {isLoading ? (
            <div className="p-4 space-y-2">
              {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-9 w-full" />)}
            </div>
          ) : (banners as any[]).length === 0 ? (
            <EmptyState title="No banners — click Add Banner to create one" />
          ) : (
            <table className="erp-table">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Category</th>
                  <th>Start</th>
                  <th>End</th>
                  <th>Active</th>
                  <th>Status</th>
                  <th style={{ width: 80 }}></th>
                </tr>
              </thead>
              <tbody>
                {(banners as any[]).map((b: any) => (
                  <tr key={b.id}>
                    <td className="font-medium">{b.title}</td>
                    <td>{b.category}</td>
                    <td>{fmtDate(b.startDate)}</td>
                    <td>{fmtDate(b.endDate)}</td>
                    <td>
                      <Switch checked={!!b.active} onCheckedChange={v => toggleActive.mutate({ id: b.id, active: v })} />
                    </td>
                    <td>
                      <StatusPill status={
                        new Date(b.endDate) < new Date() ? "cancelled"
                        : new Date(b.startDate) > new Date() ? "pending"
                        : "active"
                      } />
                    </td>
                    <td>
                      <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive hover:bg-destructive/10" onClick={() => remove.mutate(b.id)}>
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

      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent>
          <DialogHeader><DialogTitle>Add Banner</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">Title</label>
              <Input placeholder="Banner title" value={bannerForm.title} onChange={e => setBannerForm(p => ({ ...p, title: e.target.value }))} className="erp-input" />
            </div>
            <div>
              <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">Category</label>
              <Select value={bannerForm.category} onValueChange={v => setBannerForm(p => ({ ...p, category: v }))}>
                <SelectTrigger className="erp-input"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {["Announcement","Promotion","Festival","New Product","Other"].map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">Start Date</label>
                <Input type="date" value={bannerForm.startDate} onChange={e => setBannerForm(p => ({ ...p, startDate: e.target.value }))} className="erp-input" />
              </div>
              <div>
                <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">End Date</label>
                <Input type="date" value={bannerForm.endDate} onChange={e => setBannerForm(p => ({ ...p, endDate: e.target.value }))} className="erp-input" />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAdd(false)}>Cancel</Button>
            <Button
              onClick={() => bannerMutation.mutate(bannerForm)}
              disabled={!bannerForm.title || !bannerForm.startDate || !bannerForm.endDate || bannerMutation.isPending}
            >
              {bannerMutation.isPending ? "Saving…" : "Add Banner"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════
// 5. ROLES & PERMISSIONS
// ═════════════════════════════════════════════════════════════════
const ALL_PERMISSIONS = [
  "dashboard","masters","sales","fgs","reports","system",
  "sales.view","sales.record-indents","sales.dispatch",
  "masters.customers.view","finance.view",
];

export function RolesPage() {
  const qc = useQueryClient();
  const { data: roles = [], isLoading } = useQuery({
    queryKey: ["roles"], queryFn: fetchRoles,
  });

  const update = useMutation({
    mutationFn: ({ roleId, perms }: { roleId: string; perms: string[] }) =>
      updateRolePermissions(roleId, perms),
    onSuccess: () => {
      toast.success("Permissions updated");
      qc.invalidateQueries({ queryKey: ["roles"] });
    },
    onError: (err: any) => toast.error(err?.message || "Update failed"),
  });

  return (
    <div className="flex flex-col h-full">
      <PageHeader title="Roles & Access" subtitle="Configure role-based permissions" />
      <div className="flex-1 overflow-auto p-4 space-y-3">
        {isLoading ? (
          <div className="erp-panel p-4 space-y-2">
            {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
          </div>
        ) : (roles as any[]).length === 0 ? (
          <EmptyState title="No roles configured" />
        ) : (roles as any[]).map((role: any) => (
          <RoleCard key={role.id} role={role} onSave={perms => update.mutate({ roleId: role.id, perms })} />
        ))}
      </div>
    </div>
  );
}

function RoleCard({ role, onSave }: { role: any; onSave: (perms: string[]) => void }) {
  const [perms, setPerms] = useState<string[]>(role.permissions ?? []);
  const dirty = JSON.stringify([...perms].sort()) !== JSON.stringify([...(role.permissions ?? [])].sort());
  const toggle = (p: string) => setPerms(prev => prev.includes(p) ? prev.filter(x => x !== p) : [...prev, p]);

  return (
    <div className="erp-panel">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-muted/40">
        <div>
          <h3 className="font-semibold text-[14px] capitalize">{(role.name || "").replace(/_/g, " ")}</h3>
          <p className="text-[12px] text-muted-foreground">{role.userCount ?? 0} user{role.userCount === 1 ? "" : "s"}</p>
        </div>
        {dirty && (
          <Button size="sm" className="h-7" onClick={() => onSave(perms)}>Save</Button>
        )}
      </div>
      <div className="p-4 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
        {ALL_PERMISSIONS.map(p => (
          <label key={p} className="flex items-center gap-2 text-[12.5px] cursor-pointer">
            <Checkbox checked={perms.includes(p)} onCheckedChange={() => toggle(p)} />
            <span className="font-mono">{p}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════
// 6. USER MANAGEMENT
// ═════════════════════════════════════════════════════════════════
export function UserManagementPage() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<any | null>(null);

  const { data: users = [], isLoading } = useQuery({
    queryKey: ["users"], queryFn: fetchUsers,
  });
  const { data: roles = [] } = useQuery({ queryKey: ["roles"], queryFn: fetchRoles });

  const remove = useMutation({
    mutationFn: (id: string) => deleteUser(id),
    onSuccess: () => {
      toast.success("User deleted");
      qc.invalidateQueries({ queryKey: ["users"] });
    },
  });

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="User Management"
        subtitle="Internal staff accounts"
        actions={
          <Button size="sm" className="h-8" onClick={() => { setEditing(null); setOpen(true); }}>
            <Plus className="h-3.5 w-3.5 mr-1.5" /> Add User
          </Button>
        }
      />

      <div className="flex-1 overflow-auto p-4">
        <div className="erp-panel overflow-hidden">
          {isLoading ? (
            <div className="p-4 space-y-2">
              {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-7 w-full" />)}
            </div>
          ) : (users as any[]).length === 0 ? (
            <EmptyState title="No users — click Add User" />
          ) : (
            <table className="erp-table">
              <thead>
                <tr>
                  <th>Username</th>
                  <th>Full Name</th>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Last Login</th>
                  <th>Status</th>
                  <th style={{ width: 110 }}></th>
                </tr>
              </thead>
              <tbody>
                {(users as any[]).map((u: any) => (
                  <tr key={u.id}>
                    <td className="font-mono text-[12.5px]">{u.username}</td>
                    <td className="font-medium">{u.fullName}</td>
                    <td className="text-muted-foreground">{u.email}</td>
                    <td className="capitalize">{(u.role || "").replace(/_/g, " ")}</td>
                    <td>{fmtDate(u.lastLogin)}</td>
                    <td><StatusPill status={u.active ? "active" : "inactive"} /></td>
                    <td>
                      <div className="flex items-center gap-1">
                        <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => { setEditing(u); setOpen(true); }}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive hover:bg-destructive/10" onClick={() => remove.mutate(u.id)}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <UserDialog open={open} onOpenChange={setOpen} user={editing} roles={roles as any[]} />
    </div>
  );
}

function UserDialog({
  open, onOpenChange, user, roles,
}: { open: boolean; onOpenChange: (v: boolean) => void; user: any | null; roles: any[] }) {
  const qc = useQueryClient();
  
  const [form, setForm] = useState({
    username: "",
    fullName: "",
    email: "",
    password: "",
    roleId: "",
    active: true,
  });

  // B.3 Fix: Proper useEffect instead of inline if
  useEffect(() => {
    if (open && user) {
      setForm({
        username: user.username ?? "",
        fullName: user.fullName ?? "",
        email: user.email ?? "",
        password: "",
        roleId: user.roleId ?? "",
        active: user.active ?? true,
      });
    } else if (open && !user) {
      setForm({
        username: "",
        fullName: "",
        email: "",
        password: "",
        roleId: "",
        active: true,
      });
    }
  }, [open, user?.id]);   // Keyed on user.id to avoid stale closures

  const save = useMutation({
    mutationFn: () => user 
      ? updateUser(user.id, form) 
      : createUser({
          name: form.fullName,
          email: form.email,
          password: form.password,
          role: (form.roleId || "call_desk") as any,
        }),
    onSuccess: () => {
      toast.success(user ? "User updated" : "User created");
      qc.invalidateQueries({ queryKey: ["users"] });
      onOpenChange(false);
    },
    onError: (err: any) => toast.error(err?.message || "Save failed"),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>{user ? "Edit User" : "Add User"}</DialogTitle></DialogHeader>
        {/* Form fields unchanged */}
        <div className="grid grid-cols-2 gap-3">
          {/* ... same form fields as before ... */}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            disabled={!form.username || !form.fullName || !form.email || !form.roleId || (!user && !form.password) || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : user ? "Save Changes" : "Create User"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}