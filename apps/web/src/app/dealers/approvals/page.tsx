"use client";
import { PageHeader, Badge, Button } from "@/components/ui";
import { Check, X } from "lucide-react";
import { cn } from "@/lib/utils";
const DATA = [
  { id: "APR-001", name: "Venkatesh Stores", type: "New Registration", loc: "Haveri", date: "23 Jan 2025", docs: 3, status: "pending" },
  { id: "APR-002", name: "Basavaraj Agencies", type: "New Registration", loc: "Ranebennur", date: "22 Jan 2025", docs: 4, status: "pending" },
  { id: "APR-003", name: "Raju Agencies", type: "Credit Limit Increase", loc: "Haveri", date: "21 Jan 2025", docs: 1, status: "pending" },
  { id: "APR-004", name: "Krishna Stores", type: "Address Change", loc: "Ranebennur", date: "20 Jan 2025", docs: 2, status: "approved" },
  { id: "APR-005", name: "Laxmi Traders", type: "GST Update", loc: "Savanur", date: "19 Jan 2025", docs: 1, status: "rejected" },
];
export default function ApprovalsPage() {
  const pendingCount = DATA.filter(d => d.status === "pending").length;
  return (
    <>
      <PageHeader icon="✅" title="Approvals" subtitle="Approve or reject dealer requests and changes"
        actions={<Badge variant="pending" className="text-[11px] px-3 py-1">{pendingCount} Pending</Badge>} />
      <div className="space-y-3">
        {DATA.map(d => (
          <div key={d.id} className={cn("bg-card rounded-[10px] border shadow-card p-4", d.status === "pending" ? "border-warning/30" : "border-border", d.status !== "pending" && "opacity-60")}>
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1"><span className="text-[11px] font-bold text-muted-fg">{d.id}</span><Badge variant={d.status}>{d.status}</Badge></div>
                <div className="text-[13px] font-bold text-fg">{d.name}</div>
                <div className="text-[11px] text-muted-fg mt-0.5">{d.type} · {d.loc} · {d.date} · {d.docs} document(s)</div>
              </div>
              {d.status === "pending" && (
                <div className="flex gap-2 shrink-0">
                  <Button variant="outline" size="sm" className="text-success border-success/30 hover:bg-success/10"><Check className="h-3.5 w-3.5" /> Approve</Button>
                  <Button variant="outline" size="sm" className="text-danger border-danger/30 hover:bg-danger/10"><X className="h-3.5 w-3.5" /> Reject</Button>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
