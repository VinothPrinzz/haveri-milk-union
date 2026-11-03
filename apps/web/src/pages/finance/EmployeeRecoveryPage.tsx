// apps/web/src/pages/finance/EmployeeRecoveryPage.tsx
// Finance → Employee Salary Recovery  (/finance/employee-recoveries)
//
// Subsidised goods (the ghee sachet etc.) are supplied to employees on
// credit and recovered from their salary. Each month finance enters what
// payroll deducted; every line posts a credit on the employee's ledger, so
// the outstanding comes down as and when it is recovered.
//
//   • Due list   — every employee who owes, with the amount defaulting to
//                  the full outstanding. Untick or edit a line for a partial
//                  deduction, then post the batch.
//   • Posted     — recoveries already entered for the month, each with a
//                  Reverse action for one keyed in error.
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import PageHeader, { FilterBar, StatCard, EmptyState, fmtINR } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Search, BadgeIndianRupee, CheckCircle2, Users, Undo2 } from "lucide-react";
import { todayIST } from "@/lib/istDate";
import {
  fetchEmployeeRecoveryDue, fetchEmployeeRecoveries,
  postEmployeeRecoveries, reverseEmployeeRecovery,
  type EmployeeRecoveryDueRow,
} from "@/services/api";

// Same finance roles that may change employee credit limits.
const CAN_EDIT = new Set(["accountant", "manager", "super_admin", "call_desk"]);

const fmtDMY = (iso: string) => {
  const [y, m, d] = String(iso ?? "").slice(0, 10).split("-");
  return y && m && d ? `${d}-${m}-${y}` : (iso ?? "");
};
const round2 = (n: number) => Math.round(n * 100) / 100;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// "2026-11" → "Nov 2026"
const fmtMonth = (ym: string) => {
  const [y, m] = ym.split("-");
  return `${MONTHS[Number(m) - 1] ?? m} ${y}`;
};
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export default function EmployeeRecoveryPage() {
  const { user } = useAuth();
  const canEdit = CAN_EDIT.has(user?.role ?? "");
  const qc = useQueryClient();

  const today = todayIST();
  const [month, setMonth] = useState(today.slice(0, 7));
  const [recoveryDate, setRecoveryDate] = useState(today);
  const [note, setNote] = useState("");
  const [search, setSearch] = useState("");

  // employeeId → { checked, amount text }
  const [lines, setLines] = useState<Record<string, { checked: boolean; amount: string }>>({});

  const { data: due = [], isLoading } = useQuery({
    queryKey: ["employee-recovery-due", month, search.trim()],
    queryFn: () => fetchEmployeeRecoveryDue({ month, search: search.trim() || undefined }),
  });
  const { data: posted = [], isLoading: postedLoading } = useQuery({
    queryKey: ["employee-recoveries", month],
    queryFn: () => fetchEmployeeRecoveries(month),
  });

  // Seed each owing employee with the full outstanding, ticked. Lines the
  // user already touched keep their values when the list refetches.
  useEffect(() => {
    setLines(prev => {
      const next: typeof prev = {};
      for (const r of due) {
        next[r.id] = prev[r.id] ?? {
          checked: r.outstanding > 0,
          amount: r.outstanding > 0 ? r.outstanding.toFixed(2) : "",
        };
      }
      return next;
    });
  }, [due]);

  const owing = useMemo(() => due.filter(r => r.outstanding > 0), [due]);
  const selected = owing.filter(r => lines[r.id]?.checked && Number(lines[r.id]?.amount) > 0);
  const selectedTotal = round2(selected.reduce((s, r) => s + Number(lines[r.id]!.amount), 0));
  const overLines = selected.filter(r => Number(lines[r.id]!.amount) > r.outstanding + 0.001);
  const totalOutstanding = round2(owing.reduce((s, r) => s + r.outstanding, 0));
  const activePosted = posted.filter(p => !p.reversedOn);
  const recoveredThisMonth = round2(activePosted.reduce((s, p) => s + p.amount, 0));

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["employee-recovery-due"] });
    qc.invalidateQueries({ queryKey: ["employee-recoveries"] });
    qc.invalidateQueries({ queryKey: ["employee-credit-limits"] });
    qc.invalidateQueries({ queryKey: ["employee-credit-summary"] });
  };

  const post = useMutation({
    mutationFn: () => postEmployeeRecoveries({
      recoveryDate,
      salaryMonth: month,
      note: note.trim() || undefined,
      items: selected.map(r => ({ employeeId: r.id, amount: round2(Number(lines[r.id]!.amount)) })),
    }),
    onSuccess: (res) => {
      toast.success(`Recovered ${fmtINR(res.total)} from ${res.posted} employee${res.posted === 1 ? "" : "s"}`);
      setLines({});
      setNote("");
      invalidate();
    },
    onError: (e: any) => toast.error(e?.message ?? "Failed to post recoveries"),
  });

  const reverse = useMutation({
    mutationFn: (id: string) => reverseEmployeeRecovery(id),
    onSuccess: () => { toast.success("Recovery reversed"); invalidate(); },
    onError: (e: any) => toast.error(e?.message ?? "Failed to reverse recovery"),
  });

  const setLine = (id: string, patch: Partial<{ checked: boolean; amount: string }>) =>
    setLines(prev => ({ ...prev, [id]: { ...(prev[id] ?? { checked: false, amount: "" }), ...patch } }));

  const allChecked = owing.length > 0 && owing.every(r => lines[r.id]?.checked);
  const toggleAll = (v: boolean) =>
    setLines(prev => {
      const next = { ...prev };
      for (const r of owing) next[r.id] = { ...(next[r.id] ?? { amount: r.outstanding.toFixed(2) }), checked: v };
      return next;
    });

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Employee Salary Recovery"
        subtitle="Record subsidy dues recovered from employee salaries. Each recovery reduces the employee's outstanding."
      />

      <FilterBar>
        <div>
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">Salary Month</label>
          <Input type="month" value={month} onChange={e => e.target.value && setMonth(e.target.value)} className="erp-input w-40" />
        </div>
        <div>
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">Recovery Date</label>
          <Input type="date" value={recoveryDate} onChange={e => setRecoveryDate(e.target.value)} className="erp-input w-40" />
        </div>
        <div className="flex-1 min-w-[200px]">
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">Search</label>
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Employee name / PF no." className="erp-input pl-7 w-full" />
          </div>
        </div>
      </FilterBar>

      <div className="flex-1 overflow-auto p-4 space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard label="Outstanding Now" tone={totalOutstanding > 0 ? "danger" : "default"} value={fmtINR(totalOutstanding)} icon={<BadgeIndianRupee className="h-5 w-5" />} />
          <StatCard label="Employees Owing" tone="default" value={owing.length} hint={owing.length === 1 ? "employee" : "employees"} icon={<Users className="h-5 w-5" />} />
          <StatCard label="Recovered This Month" tone="success" value={fmtINR(recoveredThisMonth)} hint={activePosted.length === 1 ? "1 entry" : `${activePosted.length} entries`} icon={<CheckCircle2 className="h-5 w-5" />} />
          <StatCard label="Selected to Post" tone="default" value={fmtINR(selectedTotal)} hint={plural(selected.length, "employee")} icon={<BadgeIndianRupee className="h-5 w-5" />} />
        </div>

        {!canEdit && (
          <div className="rounded-sm border border-warning/40 bg-warning/10 px-3 py-2 text-[12px] text-warning">
            You have read-only access. Only Finance (accountant) users can record or reverse recoveries.
          </div>
        )}

        {/* ── Due list ── */}
        <div className="erp-panel overflow-hidden">
          <div className="px-4 py-2.5 border-b border-border flex items-center gap-3 flex-wrap">
            <h3 className="font-semibold text-[14px] mr-auto">Outstanding to recover</h3>
            {canEdit && (
              <>
                <Input
                  value={note}
                  onChange={e => setNote(e.target.value)}
                  placeholder="Note (optional), e.g. payroll ref."
                  className="erp-input h-8 w-64"
                  maxLength={200}
                />
                <Button
                  size="sm"
                  className="h-8"
                  disabled={post.isPending || selected.length === 0 || overLines.length > 0 || !recoveryDate}
                  onClick={() => post.mutate()}
                >
                  {post.isPending ? "Posting…" : `Post recovery · ${fmtINR(selectedTotal)}`}
                </Button>
              </>
            )}
          </div>
          {overLines.length > 0 && (
            <div className="px-4 py-2 text-[12px] text-destructive border-b border-border bg-destructive/5">
              Amount is more than the outstanding for: {overLines.map(r => r.name).join(", ")}
            </div>
          )}
          {isLoading ? (
            <div className="p-4 space-y-2">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-7 w-full" />)}</div>
          ) : owing.length === 0 ? (
            <EmptyState title="No employee has an outstanding balance" />
          ) : (
            <table className="erp-table">
              <thead>
                <tr>
                  {canEdit && (
                    <th style={{ width: 36 }}>
                      <Checkbox checked={allChecked} onCheckedChange={v => toggleAll(v === true)} />
                    </th>
                  )}
                  <th>PF No.</th><th>Employee</th><th>Department</th>
                  <th className="num" style={{ textAlign: "right" }}>Recovered this month</th>
                  <th className="num" style={{ textAlign: "right" }}>Outstanding</th>
                  {canEdit && <th className="num" style={{ textAlign: "right", width: 150 }}>Recover now ₹</th>}
                </tr>
              </thead>
              <tbody>
                {owing.map((r: EmployeeRecoveryDueRow) => {
                  const line = lines[r.id];
                  const over = Number(line?.amount) > r.outstanding + 0.001;
                  return (
                    <tr key={r.id}>
                      {canEdit && (
                        <td>
                          <Checkbox checked={!!line?.checked} onCheckedChange={v => setLine(r.id, { checked: v === true })} />
                        </td>
                      )}
                      <td className="font-mono text-[11px]">{r.code ?? ""}</td>
                      <td className="font-medium">{r.name}</td>
                      <td className="text-[12px]">{r.department ?? ""}</td>
                      <td className="num" style={{ textAlign: "right" }}>{r.recoveredInMonth ? fmtINR(r.recoveredInMonth) : ""}</td>
                      <td className="num text-destructive" style={{ textAlign: "right" }}>{fmtINR(r.outstanding)}</td>
                      {canEdit && (
                        <td className="num" style={{ textAlign: "right" }}>
                          <Input
                            type="number" min={0} step="0.01"
                            value={line?.amount ?? ""}
                            onChange={e => setLine(r.id, { amount: e.target.value, checked: true })}
                            className={`erp-input h-6 w-28 text-right ml-auto ${over ? "border-destructive" : ""}`}
                          />
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* ── Posted this month ── */}
        <div className="erp-panel overflow-hidden">
          <div className="px-4 py-2.5 border-b border-border">
            <h3 className="font-semibold text-[14px]">Recoveries posted for {fmtMonth(month)}</h3>
          </div>
          {postedLoading ? (
            <div className="p-4 space-y-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-7 w-full" />)}</div>
          ) : posted.length === 0 ? (
            <EmptyState title="No recoveries posted for this month yet" />
          ) : (
            <table className="erp-table">
              <thead>
                <tr>
                  <th>Date</th><th>PF No.</th><th>Employee</th><th>Description</th><th>Posted by</th>
                  <th className="num" style={{ textAlign: "right" }}>Amount</th>
                  {canEdit && <th style={{ width: 150 }}></th>}
                </tr>
              </thead>
              <tbody>
                {posted.map(p => (
                  <tr key={p.id} className={p.reversedOn ? "text-muted-foreground" : ""}>
                    <td className="text-[12px]">{fmtDMY(p.recoveryDate)}</td>
                    <td className="font-mono text-[11px]">{p.employeeCode ?? ""}</td>
                    <td className="font-medium">{p.employeeName}</td>
                    <td className="text-[12px]">{p.description ?? ""}</td>
                    <td className="text-[12px]">{p.postedBy ?? ""}</td>
                    <td className={`num ${p.reversedOn ? "line-through" : ""}`} style={{ textAlign: "right" }}>{fmtINR(p.amount)}</td>
                    {canEdit && (
                      <td>
                        {p.reversedOn ? (
                          <span className="text-[11px] whitespace-nowrap">Reversed {fmtDMY(p.reversedOn)}</span>
                        ) : (
                          <Button
                            size="sm" variant="outline" className="h-6"
                            disabled={reverse.isPending}
                            onClick={() => {
                              if (window.confirm(`Reverse ${fmtINR(p.amount)} recovered from ${p.employeeName}?`)) reverse.mutate(p.id);
                            }}
                          >
                            <Undo2 className="h-3 w-3 mr-1" /> Reverse
                          </Button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
