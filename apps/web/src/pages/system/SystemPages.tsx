import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import PageHeader from "@/components/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { 
  fetchTimeWindows, 
  updateTimeWindow, 
  fetchNotificationSettings, 
  fetchBanners, 
  createBanner, 
  deleteBanner, 
  fetchSystemUsers, 
  fetchRoles, 
  fetchCustomers,
  sendNotification,
  createUser 
} from "@/services/api";
import { toast } from "sonner";
import { Skeleton } from "@/components/ui/skeleton";
import { Trash2, Plus, Edit } from "lucide-react";

export function TimeWindowsPage() {
  const qc = useQueryClient();
  const { data: windows = [], isLoading } = useQuery({ queryKey: ["time-windows"], queryFn: fetchTimeWindows });
  
  const [edits, setEdits] = useState<Record<string, Record<string, string | boolean>>>({});
  const setEdit = (id: string, field: string, value: string | boolean) => 
    setEdits(p => ({ ...p, [id]: { ...p[id], [field]: value } }));

  const saveMutation = useMutation({
    mutationFn: async () => {
      for (const [id, data] of Object.entries(edits)) {
        await updateTimeWindow(id, data);
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["time-windows"] });
      toast.success("Time windows updated");
      setEdits({});
    },
  });

  return (
    <div>
      <PageHeader title="Time Windows" description="Configure ordering window times per zone">
        <Button 
          onClick={() => saveMutation.mutate()} 
          disabled={Object.keys(edits).length === 0 || saveMutation.isPending}
        >
          Save Changes
        </Button>
      </PageHeader>
      {/* Rest of TimeWindowsPage remains unchanged */}
      <Card>
        <CardContent className="p-0">
          {isLoading ? <div className="p-5"><Skeleton className="h-48" /></div> : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/30 text-xs text-muted-foreground">
                  <th className="text-left py-2.5 px-3 font-medium">Zone</th>
                  <th className="text-left py-2.5 px-3 font-medium">Open Time</th>
                  <th className="text-left py-2.5 px-3 font-medium">Warning Time</th>
                  <th className="text-left py-2.5 px-3 font-medium">Close Time</th>
                  <th className="text-left py-2.5 px-3 font-medium">Active</th>
                  <th className="text-left py-2.5 px-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {windows.map(w => {
                  const e = edits[w.id] || {};
                  const active = e.active !== undefined ? e.active as boolean : w.active;
                  return (
                    <tr key={w.id} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="py-2.5 px-3 font-medium">{w.zoneName}</td>
                      <td className="py-2.5 px-3">
                        <input type="time" value={(e.openTime as string) ?? w.openTime} 
                          onChange={ev => setEdit(w.id, "openTime", ev.target.value)} 
                          className="h-8 w-32 rounded-md border border-input bg-background px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" />
                      </td>
                      <td className="py-2.5 px-3">
                        <input type="time" value={(e.warningTime as string) ?? w.warningTime} 
                          onChange={ev => setEdit(w.id, "warningTime", ev.target.value)} 
                          className="h-8 w-32 rounded-md border border-input bg-background px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" />
                      </td>
                      <td className="py-2.5 px-3">
                        <input type="time" value={(e.closeTime as string) ?? w.closeTime} 
                          onChange={ev => setEdit(w.id, "closeTime", ev.target.value)} 
                          className="h-8 w-32 rounded-md border border-input bg-background px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" />
                      </td>
                      <td className="py-2.5 px-3"><Switch checked={active} onCheckedChange={v => setEdit(w.id, "active", v)} /></td>
                      <td className="py-2.5 px-3">
                        <span className={`text-xs px-2 py-0.5 rounded font-medium ${active ? "bg-success/10 text-success" : "bg-muted text-muted-foreground"}`}>
                          {active ? "Active" : "Inactive"}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export function NotificationsPage() {
  const { data: settings = [], isLoading } = useQuery({ 
    queryKey: ["notification-settings"], 
    queryFn: fetchNotificationSettings 
  });

  return (
    <div>
      <PageHeader title="Notification Settings" description="Configure which notifications are sent and to whom" />
      <Card>
        <CardContent className="p-0">
          {isLoading ? <div className="p-5"><Skeleton className="h-48" /></div> : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/30 text-xs text-muted-foreground">
                  <th className="text-left py-2.5 px-3 font-medium">Type</th>
                  <th className="text-left py-2.5 px-3 font-medium">Description</th>
                  <th className="text-center py-2.5 px-3 font-medium">Admin</th>
                  <th className="text-center py-2.5 px-3 font-medium">Dealer</th>
                  <th className="text-center py-2.5 px-3 font-medium">Contractor</th>
                  <th className="text-center py-2.5 px-3 font-medium">Enabled</th>
                </tr>
              </thead>
              <tbody>
                {settings.map((ns: any) => (
                  <tr key={ns.id} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="py-2.5 px-3 font-medium">{ns.type}</td>
                    <td className="py-2.5 px-3 text-muted-foreground text-xs">{ns.description}</td>
                    <td className="py-2.5 px-3 text-center"><Switch checked={ns.sendToAdmin} /></td>
                    <td className="py-2.5 px-3 text-center"><Switch checked={ns.sendToDealer} /></td>
                    <td className="py-2.5 px-3 text-center"><Switch checked={ns.sendToContractor} /></td>
                    <td className="py-2.5 px-3 text-center"><Switch checked={ns.enabled} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export function DealerNotificationsPage() {
  const qc = useQueryClient();
  const { data: customers = [] } = useQuery({ queryKey: ["customers"], queryFn: fetchCustomers });

  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [selectedDealer, setSelectedDealer] = useState<string>("");

  const sendMutation = useMutation({
    mutationFn: (payload: {
      title: string;
      message: string;
      target: { type: "all" | "dealer"; id?: string };
    }) => sendNotification(payload),
    onSuccess: () => {
      toast.success("Notification queued successfully");
      setTitle("");
      setMessage("");
      setSelectedDealer("");
    },
    onError: (err: any) => toast.error(err.message || "Failed to send notification"),
  });

  return (
    <div>
      <PageHeader title="Dealer Notifications" description="Send push notifications to dealers" />
      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle className="text-base">Send New Notification</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label className="text-sm font-medium mb-1.5 block">Title</label>
            <Input placeholder="Notification title" value={title} onChange={e => setTitle(e.target.value)} />
          </div>
          <div>
            <label className="text-sm font-medium mb-1.5 block">Message</label>
            <textarea 
              value={message} 
              onChange={e => setMessage(e.target.value)} 
              className="w-full h-24 rounded-md border border-input bg-background px-3 py-2 text-sm resize-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" 
              placeholder="Enter notification message..." 
            />
          </div>
          <div>
            <label className="text-sm font-medium mb-1.5 block">Send To</label>
            <Select value={selectedDealer} onValueChange={setSelectedDealer}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select dealer or all" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Active Dealers</SelectItem>
                {customers.filter(c => c.status === "Active").map(c => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.code} — {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Button 
            onClick={() => sendMutation.mutate({
              title,
              message,
              target: (selectedDealer && selectedDealer !== "all")
                ? { type: "dealer", id: selectedDealer }
                : { type: "all" }
            })}
            disabled={!title || !message || sendMutation.isPending}
          >
            {sendMutation.isPending ? "Sending..." : "Send Notification"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

export function BannerManagementPage() {
  const qc = useQueryClient();
  const { data: banners = [], isLoading } = useQuery({ queryKey: ["banners"], queryFn: fetchBanners });

  const [showAdd, setShowAdd] = useState(false);
  const [bannerForm, setBannerForm] = useState({
    title: "",
    category: "Announcement",
    startDate: "",
    endDate: "",
    imageUrl: "",
    linkUrl: ""
  });

  const deleteMutation = useMutation({
    mutationFn: deleteBanner,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["banners"] });
      toast.success("Banner deleted");
    }
  });

  const bannerMutation = useMutation({
    mutationFn: (data: any) => createBanner(data),
    onSuccess: () => {
      toast.success("Banner created");
      qc.invalidateQueries({ queryKey: ["banners"] });
      setShowAdd(false);
      setBannerForm({ title: "", category: "Announcement", startDate: "", endDate: "", imageUrl: "", linkUrl: "" });
    },
    onError: (err: any) => toast.error(err.message || "Failed to create banner"),
  });

  return (
    <div>
      <PageHeader title="Banner Management" description="Manage promotional banners in the dealer app">
        <Button size="sm" onClick={() => setShowAdd(true)}>
          <Plus className="h-4 w-4 mr-1" />New Banner
        </Button>
      </PageHeader>

      <Card>
        <CardContent className="p-0">
          {isLoading ? <div className="p-5"><Skeleton className="h-48" /></div> : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/30 text-xs text-muted-foreground">
                  <th className="text-left py-2.5 px-3 font-medium">Title</th>
                  <th className="text-left py-2.5 px-3 font-medium">Category</th>
                  <th className="text-left py-2.5 px-3 font-medium">Start Date</th>
                  <th className="text-left py-2.5 px-3 font-medium">End Date</th>
                  <th className="text-left py-2.5 px-3 font-medium">Status</th>
                  <th className="text-left py-2.5 px-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {banners.map((b: any) => (
                  <tr key={b.id} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="py-2.5 px-3 font-medium">{b.title}</td>
                    <td className="py-2.5 px-3">{b.category}</td>
                    <td className="py-2.5 px-3">{b.startDate}</td>
                    <td className="py-2.5 px-3">{b.endDate}</td>
                    <td className="py-2.5 px-3">
                      <span className={`text-xs px-2 py-0.5 rounded font-medium ${b.status === "Active" ? "bg-success/10 text-success" : "bg-muted text-muted-foreground"}`}>
                        {b.status}
                      </span>
                    </td>
                    <td className="py-2.5 px-3">
                      <div className="flex items-center gap-1">
                        <Button variant="ghost" size="icon" className="h-7 w-7"><Edit className="h-3.5 w-3.5" /></Button>
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive" onClick={() => deleteMutation.mutate(b.id)}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
                {banners.length === 0 && <tr><td colSpan={6} className="py-8 text-center text-muted-foreground">No banners yet</td></tr>}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent>
          <DialogHeader><DialogTitle>Add New Banner</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-sm font-medium mb-1.5 block">Title</label>
              <Input placeholder="Banner title" value={bannerForm.title} onChange={e => setBannerForm(p => ({ ...p, title: e.target.value }))} />
            </div>
            <div>
              <label className="text-sm font-medium mb-1.5 block">Category</label>
              <Select value={bannerForm.category} onValueChange={v => setBannerForm(p => ({ ...p, category: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {["Announcement","Promotion","Festival","New Product","Other"].map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm font-medium mb-1.5 block">Start Date</label>
                <input type="date" value={bannerForm.startDate} onChange={e => setBannerForm(p => ({ ...p, startDate: e.target.value }))} className="h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm" />
              </div>
              <div>
                <label className="text-sm font-medium mb-1.5 block">End Date</label>
                <input type="date" value={bannerForm.endDate} onChange={e => setBannerForm(p => ({ ...p, endDate: e.target.value }))} className="h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm" />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAdd(false)}>Cancel</Button>
            <Button 
              onClick={() => bannerMutation.mutate(bannerForm)}
              disabled={!bannerForm.title || !bannerForm.startDate || !bannerForm.endDate || bannerMutation.isPending}
            >
              {bannerMutation.isPending ? "Saving..." : "Add Banner"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// RolesPage and UserManagementPage remain mostly same except User Create button

export function RolesPage() {
  const { data: roles = [], isLoading } = useQuery({ queryKey: ["roles"], queryFn: fetchRoles });
  const allPermissions = ["dashboard","masters","sales","fgs","reports","system","sales.view","sales.record-indents","sales.dispatch","masters.customers.view","finance.view"];

  return (
    <div>
      <PageHeader title="Roles & Access" description="Configure role-based permissions" />
      <div className="space-y-4">
        {isLoading ? <Skeleton className="h-48" /> : roles.map((role: any) => (
          <Card key={role.role}>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">{role.role}</CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="flex flex-wrap gap-4">
                {allPermissions.map(perm => (
                  <div key={perm} className="flex items-center gap-1.5">
                    <Switch checked={role.permissions.includes(perm)} className="scale-75" disabled />
                    <span className="text-xs text-muted-foreground">{perm}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

export function UserManagementPage() {
  const qc = useQueryClient();
  const { data: users = [], isLoading } = useQuery({ queryKey: ["system-users"], queryFn: fetchSystemUsers });

  const [showAdd, setShowAdd] = useState(false);
  const [userForm, setUserForm] = useState({
    name: "",
    email: "",
    password: "",
    role: "call_desk",
    phone: ""
  });

  const userMutation = useMutation({
    mutationFn: (data: any) => createUser(data),
    onSuccess: () => {
      toast.success("User created successfully");
      qc.invalidateQueries({ queryKey: ["system-users"] });
      setShowAdd(false);
      setUserForm({ name: "", email: "", password: "", role: "call_desk", phone: "" });
    },
    onError: (err: any) => toast.error(err.message || "Failed to create user"),
  });

  return (
    <div>
      <PageHeader title="User Management" description="Manage ERP users and their access">
        <Button size="sm" onClick={() => setShowAdd(true)}>
          <Plus className="h-4 w-4 mr-1" />Add User
        </Button>
      </PageHeader>

      <Card>
        <CardContent className="p-0">
          {isLoading ? <div className="p-5"><Skeleton className="h-48" /></div> : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/30 text-xs text-muted-foreground">
                  <th className="text-left py-2.5 px-3 font-medium">Name</th>
                  <th className="text-left py-2.5 px-3 font-medium">Email</th>
                  <th className="text-left py-2.5 px-3 font-medium">Role</th>
                  <th className="text-left py-2.5 px-3 font-medium">Zone</th>
                  <th className="text-left py-2.5 px-3 font-medium">Status</th>
                  <th className="text-left py-2.5 px-3 font-medium">Last Login</th>
                  <th className="text-left py-2.5 px-3 font-medium">Edit</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u: any) => (
                  <tr key={u.id} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="py-2.5 px-3 font-medium">{u.name}</td>
                    <td className="py-2.5 px-3 text-muted-foreground">{u.email}</td>
                    <td className="py-2.5 px-3"><span className="text-xs px-2 py-0.5 rounded bg-secondary">{u.role}</span></td>
                    <td className="py-2.5 px-3">{u.zone}</td>
                    <td className="py-2.5 px-3">
                      <span className={`text-xs px-2 py-0.5 rounded font-medium ${u.status === "Active" ? "bg-success/10 text-success" : "bg-muted text-muted-foreground"}`}>
                        {u.status}
                      </span>
                    </td>
                    <td className="py-2.5 px-3 text-muted-foreground text-xs">{u.lastLogin}</td>
                    <td className="py-2.5 px-3"><Button variant="ghost" size="icon" className="h-7 w-7"><Edit className="h-3.5 w-3.5" /></Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent>
          <DialogHeader><DialogTitle>Add New User</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div><label className="text-sm font-medium mb-1.5 block">Full Name</label>
              <Input placeholder="User full name" value={userForm.name} onChange={e => setUserForm(p => ({ ...p, name: e.target.value }))} />
            </div>
            <div><label className="text-sm font-medium mb-1.5 block">Email</label>
              <Input type="email" placeholder="user@haverimunion.coop" value={userForm.email} onChange={e => setUserForm(p => ({ ...p, email: e.target.value }))} />
            </div>
            <div><label className="text-sm font-medium mb-1.5 block">Password</label>
              <Input type="password" placeholder="••••••••" value={userForm.password} onChange={e => setUserForm(p => ({ ...p, password: e.target.value }))} />
            </div>
            <div><label className="text-sm font-medium mb-1.5 block">Role</label>
              <Select value={userForm.role} onValueChange={v => setUserForm(p => ({ ...p, role: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {["super_admin","manager","dispatch_officer","accountant","call_desk"].map(r => (
                    <SelectItem key={r} value={r}>{r.replace("_", " ").toUpperCase()}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAdd(false)}>Cancel</Button>
            <Button 
              onClick={() => userMutation.mutate(userForm)}
              disabled={!userForm.name || !userForm.email || !userForm.password || userMutation.isPending}
            >
              {userMutation.isPending ? "Creating..." : "Create User"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}