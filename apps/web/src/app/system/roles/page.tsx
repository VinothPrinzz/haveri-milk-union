"use client";
import { PageHeader, Badge, Card, TableCard, Th, Td, Button } from "@/components/ui";
import { Plus, Pencil } from "lucide-react";

const ROLES = [
  { name: "Super Admin", users: 2, perms: ["All"], color: "bg-danger/10 text-danger border-danger/20" },
  { name: "Manager", users: 4, perms: ["Sales", "FGS", "Dealers", "Reports"], color: "bg-brand-light text-brand border-brand-light2" },
  { name: "Dispatch Officer", users: 3, perms: ["Routes", "FGS", "Daily Dispatch"], color: "bg-info/10 text-info border-info/20" },
  { name: "Accountant", users: 2, perms: ["Payments", "Invoices", "GST Reports"], color: "bg-success/10 text-success border-success/20" },
  { name: "Call Desk", users: 3, perms: ["New Indent", "Dealers View"], color: "bg-warning/10 text-warning border-warning/20" },
];
const MODULES = ["Dashboard", "Sales", "Products", "FGS", "Routes", "Dealers", "Payments", "Invoices", "Reports", "System"];
const MATRIX: Record<string, boolean[]> = {
  "Super Admin":      [true, true, true, true, true, true, true, true, true, true],
  "Manager":          [true, true, false, true, false, true, false, false, true, false],
  "Dispatch Officer": [true, false, false, true, true, false, false, false, false, false],
  "Accountant":       [true, false, false, false, false, false, true, true, true, false],
  "Call Desk":        [true, true, false, false, false, true, false, false, false, false],
};

export default function RolesAccessPage() {
  return (
    <>
      <PageHeader icon="🛡️" title="Roles & Access" subtitle="Define admin roles and permission levels"
        actions={<Button size="sm"><Plus className="h-3.5 w-3.5" /> Add Role</Button>} />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        {ROLES.map(r => (
          <div key={r.name} className="bg-card rounded-[10px] border border-border shadow-card p-4">
            <div className="flex items-start justify-between mb-2">
              <div><div className="text-[13px] font-bold text-fg">{r.name}</div><div className="text-[10px] text-muted-fg">{r.users} users assigned</div></div>
              <button className="p-1.5 rounded-md border border-border hover:bg-muted"><Pencil className="h-3.5 w-3.5 text-muted-fg" /></button>
            </div>
            <div className="flex flex-wrap gap-1.5 mt-2">{r.perms.map(p => <span key={p} className={`badge ${r.color}`}>{p}</span>)}</div>
          </div>
        ))}
      </div>
      <Card title="Permission Matrix">
        <div className="overflow-x-auto"><table className="w-full border-collapse">
          <thead><tr><Th>Module</Th>{ROLES.map(r => <Th key={r.name} className="text-center">{r.name}</Th>)}</tr></thead>
          <tbody>{MODULES.map((m, mi) => (
            <tr key={m} className="hover:bg-muted/50"><Td className="font-semibold bg-muted/30">{m}</Td>
              {ROLES.map(r => {
                const on = MATRIX[r.name]?.[mi] ?? false;
                return <Td key={r.name} className="text-center">
                  <div className={`w-9 h-5 rounded-full mx-auto ${on ? "bg-brand" : "bg-muted"}`} style={{position:"relative"}}>
                    <div className="absolute top-0.5 w-4 h-4 rounded-full bg-white shadow" style={{left: on ? "18px" : "2px"}} />
                  </div>
                </Td>;
              })}
            </tr>
          ))}</tbody>
        </table></div>
      </Card>
    </>
  );
}
