"use client";
import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { PageHeader, Badge, Card, Button } from "@/components/ui";
import { Modal, FormField, FormInput } from "@/components/ui/modal";
import { Plus, Pencil, Save } from "lucide-react";

const ROLE_ORDER = ["super_admin", "manager", "dispatch_officer", "accountant", "call_desk"];
const ROLE_LABELS: Record<string, string> = { super_admin: "Super Admin", manager: "Manager", dispatch_officer: "Dispatch Officer", accountant: "Accountant", call_desk: "Call Desk" };
const MODULES = ["Dashboard", "Sales", "Products", "FGS", "Routes", "Dealers", "Payments", "Invoices", "Reports", "System"];
const DEFAULT_MATRIX: Record<string, boolean[]> = {
  super_admin:      [true, true, true, true, true, true, true, true, true, true],
  manager:          [true, true, false, true, false, true, false, false, true, false],
  dispatch_officer: [true, false, false, true, true, false, false, false, false, false],
  accountant:       [true, false, false, false, false, false, true, true, true, false],
  call_desk:        [true, true, false, false, false, true, false, false, false, false],
};

function Toggle({ on, onChange }: { on: boolean; onChange: () => void }) {
  return (<button onClick={onChange} className={`w-9 h-5 rounded-full transition-colors relative ${on?"bg-brand":"bg-muted"}`}><div className="absolute top-0.5 w-4 h-4 rounded-full bg-white shadow" style={{left:on?"18px":"2px"}} /></button>);
}

export default function RolesAccessPage() {
  const { data: usersData } = useQuery({ queryKey: ["users"], queryFn: () => api.get("/api/v1/users", { page: 1, limit: 100 }) });
  const users = usersData?.data ?? [];
  const [matrix, setMatrix] = useState(DEFAULT_MATRIX);
  const [saved, setSaved] = useState(false);

  const roleCounts: Record<string, number> = {};
  users.forEach((u: any) => { roleCounts[u.role] = (roleCounts[u.role] || 0) + 1; });

  const togglePerm = (role: string, modIdx: number) => {
    if (role === "super_admin") return; // Can't modify super admin
    setMatrix(prev => ({ ...prev, [role]: prev[role]!.map((v, i) => i === modIdx ? !v : v) }));
    setSaved(false);
  };

  const handleSave = () => { setSaved(true); /* In production, this would POST to an API */ };

  const rolePerms = (role: string) => MODULES.filter((_, i) => matrix[role]?.[i]);

  return (
    <>
      <PageHeader icon="🛡️" title="Roles & Access" subtitle="Define admin roles and permission levels"
        actions={<Button size="sm" onClick={handleSave}><Save className="h-3.5 w-3.5" /> {saved?"Saved ✓":"Save Changes"}</Button>} />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        {ROLE_ORDER.map(role => (
          <div key={role} className="bg-card rounded-[10px] border border-border shadow-card p-4">
            <div className="flex items-start justify-between mb-2"><div><div className="text-[13px] font-bold text-fg">{ROLE_LABELS[role]}</div><div className="text-[10px] text-muted-fg">{roleCounts[role]||0} users assigned</div></div></div>
            <div className="flex flex-wrap gap-1.5 mt-2">{rolePerms(role).map(p => <span key={p} className="px-2 py-0.5 rounded-full text-[9px] font-bold bg-brand-light text-brand border border-brand-light2">{p}</span>)}</div>
          </div>
        ))}
      </div>
      <Card title="Permission Matrix">
        <div className="overflow-x-auto"><table className="w-full border-collapse">
          <thead><tr><th className="text-left px-4 py-2.5 text-[10px] font-semibold text-muted-fg bg-muted/30">Module</th>{ROLE_ORDER.map(r => <th key={r} className="text-center px-3 py-2.5 text-[10px] font-semibold text-muted-fg bg-muted/30">{ROLE_LABELS[r]}</th>)}</tr></thead>
          <tbody>{MODULES.map((m, mi) => (
            <tr key={m} className="border-t border-border hover:bg-muted/50"><td className="px-4 py-2.5 text-[11px] font-semibold text-fg">{m}</td>
              {ROLE_ORDER.map(r => (<td key={r} className="text-center px-3 py-2.5"><Toggle on={matrix[r]?.[mi]??false} onChange={() => togglePerm(r, mi)} /></td>))}
            </tr>
          ))}</tbody>
        </table></div>
      </Card>
    </>
  );
}
