"use client";
import { PageHeader, Badge, TableCard, Th, Td, Button } from "@/components/ui";
import { Plus, Pencil, Lock, Search } from "lucide-react";
import { useState } from "react";

const USERS = [
  { name: "Rajesh Kumar", email: "rajesh@haverimunion.coop", role: "Super Admin", lastLogin: "23 Jan, 10:15 AM", status: "active" },
  { name: "Suresh Patil", email: "suresh@haverimunion.coop", role: "Manager", lastLogin: "23 Jan, 09:30 AM", status: "active" },
  { name: "Meena Rao", email: "meena@haverimunion.coop", role: "Accountant", lastLogin: "22 Jan, 04:45 PM", status: "active" },
  { name: "Venkatesh G.", email: "venkatesh@haverimunion.coop", role: "Dispatch Officer", lastLogin: "23 Jan, 05:00 AM", status: "active" },
  { name: "Priya Sharma", email: "priya@haverimunion.coop", role: "Call Desk", lastLogin: "21 Jan, 11:00 AM", status: "inactive" },
  { name: "Anil Reddy", email: "anil@haverimunion.coop", role: "Manager", lastLogin: "23 Jan, 08:00 AM", status: "active" },
];

const ROLE_COLORS: Record<string, string> = {
  "Super Admin": "badge-danger", "Manager": "badge-brand", "Dispatch Officer": "badge-info", "Accountant": "badge-success", "Call Desk": "badge-warning",
};

export default function UserManagementPage() {
  const [search, setSearch] = useState("");
  const filtered = USERS.filter(u => search ? u.name.toLowerCase().includes(search.toLowerCase()) || u.email.toLowerCase().includes(search.toLowerCase()) : true);
  return (
    <>
      <PageHeader icon="👤" title="User Management" subtitle="Manage admin users and their access credentials"
        actions={<Button size="sm"><Plus className="h-3.5 w-3.5" /> Add User</Button>} />
      <div className="mb-5"><div className="flex items-center gap-2 bg-card border border-border rounded-lg px-3 py-2 max-w-md">
        <Search className="h-4 w-4 text-muted-fg" /><input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search users..."
          className="bg-transparent text-[12px] text-fg placeholder-muted-fg outline-none w-full font-medium" />
      </div></div>
      <TableCard>
        <thead><tr><Th>Name</Th><Th>Email</Th><Th>Role</Th><Th>Last Login</Th><Th>Status</Th><Th>Actions</Th></tr></thead>
        <tbody>{filtered.map(u => (
          <tr key={u.email} className="hover:bg-muted/50"><Td className="font-semibold">{u.name}</Td><Td>{u.email}</Td><Td><Badge variant={ROLE_COLORS[u.role] || "badge-muted"}>{u.role}</Badge></Td><Td className="text-muted-fg">{u.lastLogin}</Td><Td><Badge variant={u.status === "active" ? "active" : "inactive"}>{u.status}</Badge></Td>
            <Td><div className="flex gap-1"><button className="p-1.5 rounded-md border border-border hover:bg-muted"><Pencil className="h-3.5 w-3.5 text-muted-fg" /></button><button className="p-1.5 rounded-md border border-border hover:bg-muted"><Lock className="h-3.5 w-3.5 text-muted-fg" /></button></div></Td></tr>
        ))}</tbody>
      </TableCard>
    </>
  );
}
