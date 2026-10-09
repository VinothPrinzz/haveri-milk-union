// apps/web/src/pages/finance/LeakageIncentivePage.tsx
// ════════════════════════════════════════════════════════════════════
// Finance → Milk Leakage Incentive  (/finance/leakage-incentive)
//
// One printable page per taluk, in the union's sheet layout:
//   Sl · Code · Customer Name · Milk Total (Ltr) ·
//   Total milk as incentive @ 1.5 litre/1000 litres of milk ·
//   Rate per litre of milk · Total Incentive Amount
// plus an all-taluk summary page when there is more than one taluk.
//
// "Post Credit Notes" issues one credit note per agent for the period
// (finance.manage). Once posted, the statement shows the credited figures
// with their voucher numbers; "Reverse Run" undoes every credit note so a
// corrected run can be posted.
// ════════════════════════════════════════════════════════════════════
import { useMemo, useState, type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import { Field, fmtINR, fmtNum } from "@/components/PageHeader";
import ReportShell, { ReportPrintMeta, type Exporter } from "@/components/ReportShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { FilePlus2, History, RotateCcw, Settings2 } from "lucide-react";
import { toCsv } from "@/lib/exporters";
import { todayIST } from "@/lib/istDate";
import {
  fetchLeakageIncentiveSettings, saveLeakageIncentiveSettings,
  fetchLeakageIncentiveReport, fetchLeakageIncentiveRuns,
  postLeakageIncentiveRun, reverseLeakageIncentiveRun,
  type LeakageIncentiveReport, type LeakageIncentiveRunSummary, type LeakageIncentiveSettings,
} from "@/services/api";

// finance.manage (call_desk is a super role on the API).
const CAN_EDIT = new Set(["accountant", "super_admin", "call_desk"]);

const fmtDMY = (iso: string) => {
  const [y, m, d] = (iso ?? "").split("-");
  return y && m && d ? `${d}-${m}-${y}` : (iso ?? "");
};
const fmtPeriod = (from: string, to: string) => `${fmtDMY(from)} to ${fmtDMY(to)}`;
const fmtLtr = (n: number) => Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });
const fmt2 = (n: number) => fmtNum(n, 2);
const ruleText = (r: { litresPer1000: number; ratePerLitre: number }) =>
  `${r.litresPer1000} L per 1000 L × ${fmtINR(r.ratePerLitre)}/L`;

/** First and last day of the month before `iso`. */
function previousMonth(iso: string): { from: string; to: string } {
  const [y, m] = iso.split("-").map(Number);
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  const last = new Date(Date.UTC(py, pm, 0)).getUTCDate();
  const mm = String(pm).padStart(2, "0");
  return { from: `${py}-${mm}-01`, to: `${py}-${mm}-${String(last).padStart(2, "0")}` };
}

export default function LeakageIncentivePage() {
  const { user } = useAuth();
  const canEdit = CAN_EDIT.has(user?.role ?? "");
  const qc = useQueryClient();

  const today = todayIST();
  const initial = useMemo(() => previousMonth(today), [today]);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [generated, setGenerated] = useState(false);
  const [dialog, setDialog] = useState<null | "settings" | "post" | "reverse" | "history">(null);

  const { data: settings } = useQuery({
    queryKey: ["leakage-incentive-settings"],
    queryFn: fetchLeakageIncentiveSettings,
  });

  const { data, isFetching, refetch } = useQuery<LeakageIncentiveReport>({
    queryKey: ["leakage-incentive-report", from, to],
    queryFn: () => fetchLeakageIncentiveReport({ from, to }),
    enabled: false,
  });
  // Only trust the report for the period it was generated for.
  const report = data && data.from === from && data.to === to ? data : undefined;

  const handleGenerate = async () => {
    if (from > to) { toast.error("'From' must be on or before 'To'"); return; }
    await refetch();
    setGenerated(true);
  };
  const afterChange = () => {
    qc.invalidateQueries({ queryKey: ["leakage-incentive-runs"] });
    qc.invalidateQueries({ queryKey: ["adjustments"] });
    if (generated) refetch();
  };

  const rule = report?.rule ?? settings;
  const multiTaluk = (report?.talukas.length ?? 0) > 1;
  const posted = report?.source === "posted";

  const pages: ReactNode[] = report
    ? [
        ...report.talukas.map(t => (
          <TalukaPage key={t.name} report={report} taluka={t} />
        )),
        ...(multiTaluk ? [<SummaryPage key="__summary" report={report} />] : []),
      ]
    : [];
  const pageLabel = (i: number) =>
    report && i < report.talukas.length ? report.talukas[i].name : "All taluks";

  const exporters: Exporter[] = report ? [{
    label: "CSV",
    filename: `leakage-incentive_${from}_${to}.csv`,
    mimeType: "text/csv",
    build: () => {
      const r = report.rule;
      const out: (string | number | null)[][] = [
        ["Milk Leakage Incentive", fmtPeriod(from, to), ruleText(r)],
      ];
      for (const t of report.talukas) {
        out.push([], [`${t.name} Taluk`]);
        out.push([
          "Sl", "Code", "Customer Name", "Milk Total (Ltr)",
          `Total milk as incentive @ ${r.litresPer1000} litre/1000 litres of milk`,
          "Rate per litre of milk", "Total Incentive Amount",
          ...(posted ? ["Credit Note No."] : []),
        ]);
        t.rows.forEach(row => out.push([
          row.sl, row.code, row.name, row.milkLitres, fmt2(row.incentiveLitres),
          r.ratePerLitre.toFixed(2), row.amount.toFixed(2),
          ...(posted ? [row.reversed ? `${row.voucherNo ?? ""} (reversed)` : (row.voucherNo ?? "")] : []),
        ]));
        out.push([
          "", "", "TOTAL", t.totals.milkLitres, fmt2(t.totals.incentiveLitres),
          r.ratePerLitre.toFixed(2), t.totals.amount.toFixed(2),
        ]);
      }
      if (multiTaluk) {
        out.push([], ["All taluks"], ["Taluk", "Agents", "Milk Total (Ltr)", "Incentive (Ltr)", "Amount"]);
        report.talukas.forEach(t => out.push([
          t.name, t.rows.length, t.totals.milkLitres, fmt2(t.totals.incentiveLitres), t.totals.amount.toFixed(2),
        ]));
        out.push([
          "TOTAL", report.talukas.reduce((s, t) => s + t.rows.length, 0),
          report.totals.milkLitres, fmt2(report.totals.incentiveLitres), report.totals.amount.toFixed(2),
        ]);
      }
      return toCsv(out);
    },
  }] : [];

  const canPost = canEdit && generated && !!report && report.source === "live"
    && report.overlappingRuns.length === 0 && report.totals.amount > 0 && to <= today;

  return (
    <>
      <ReportShell
        title="Milk Leakage Incentive"
        subtitle="Taluk-wise leakage incentive on milk lifted, settled as one credit note per agent"
        printOrientation="portrait"
        filters={
          <>
            <div>
              <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">From</label>
              <Input type="date" value={from} onChange={e => setFrom(e.target.value)} className="erp-input w-40" />
            </div>
            <div>
              <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">To</label>
              <Input type="date" value={to} onChange={e => setTo(e.target.value)} className="erp-input w-40" />
            </div>
            <div className="self-end text-[12px] text-muted-foreground pb-1.5">
              {settings ? <>Rule: <span className="text-foreground font-medium">{ruleText(settings)}</span></> : "Loading rule…"}
            </div>
            {canEdit && (
              <Button size="sm" variant="outline" className="h-8 self-end" onClick={() => setDialog("settings")}>
                <Settings2 className="h-3.5 w-3.5 mr-1.5" /> Edit Rule
              </Button>
            )}
            <Button size="sm" variant="outline" className="h-8 self-end" onClick={() => setDialog("history")}>
              <History className="h-3.5 w-3.5 mr-1.5" /> History
            </Button>
            {canPost && (
              <Button size="sm" className="h-8 self-end" onClick={() => setDialog("post")}>
                <FilePlus2 className="h-3.5 w-3.5 mr-1.5" /> Post Credit Notes
              </Button>
            )}
            {canEdit && posted && report?.run && (
              <Button size="sm" variant="outline" className="h-8 self-end text-destructive" onClick={() => setDialog("reverse")}>
                <RotateCcw className="h-3.5 w-3.5 mr-1.5" /> Reverse Run
              </Button>
            )}
            {generated && report && <StatusNote report={report} today={today} />}
          </>
        }
        onGenerate={handleGenerate}
        exporters={exporters}
        printMeta={
          <ReportPrintMeta
            title="Milk Leakage Incentive"
            rows={[
              { label: "Period", value: fmtPeriod(from, to) },
              ...(rule ? [{ label: "Rule", value: ruleText(rule) }] : []),
            ]}
          />
        }
        state={{
          generated,
          loading: isFetching && !report,
          pages,
          pageLabel,
          emptyMessage: "No agent sales in this period",
        }}
      />

      {dialog === "settings" && settings && (
        <SettingsDialog settings={settings} onClose={() => setDialog(null)} onSaved={() => {
          qc.invalidateQueries({ queryKey: ["leakage-incentive-settings"] });
          if (generated) refetch();
        }} />
      )}
      {dialog === "post" && report && (
        <PostDialog report={report} today={today} onClose={() => setDialog(null)} onDone={afterChange} />
      )}
      {dialog === "reverse" && report?.run && (
        <ReverseDialog run={report.run} onClose={() => setDialog(null)} onDone={afterChange} />
      )}
      {dialog === "history" && (
        <HistoryDialog
          onClose={() => setDialog(null)}
          onOpen={(r) => { setFrom(r.periodFrom); setTo(r.periodTo); setGenerated(false); setDialog(null); }}
        />
      )}
    </>
  );
}

// ─── Status line in the filter bar ─────────────────────────────────
function StatusNote({ report, today }: { report: LeakageIncentiveReport; today: string }) {
  let text: ReactNode = null;
  let tone = "text-muted-foreground";
  if (report.source === "posted" && report.run) {
    const r = report.run;
    tone = "text-success";
    text = <>Credited on {fmtDMY(r.voucherDate)} by {r.createdByName ?? "—"}: {r.dealerCount} credit notes, {fmtINR(r.totalAmount)}</>;
    if (report.liveAmount != null && Math.abs(report.liveAmount - report.totals.amount) > 0.005) {
      tone = "text-warning";
      text = <>{text}. Sales have changed since: today's figures give {fmtINR(report.liveAmount)}.</>;
    }
  } else if (report.overlappingRuns.length) {
    const r = report.overlappingRuns[0];
    tone = "text-warning";
    text = <>Part of this period is already credited ({fmtPeriod(r.periodFrom, r.periodTo)}). Pick that exact period to view or reverse it.</>;
  } else if (report.to > today) {
    text = <>Period not over yet: credit notes can be posted after {fmtDMY(report.to)}.</>;
  } else {
    text = <>Not credited yet: {report.totals.dealerCount} agents, {fmtINR(report.totals.amount)}</>;
  }
  return <div className={`self-end pb-1.5 text-[12px] ${tone}`}>{text}</div>;
}

// ─── Printable pages ───────────────────────────────────────────────
// Report tables force one-line headers (index.css), so long headers break with <br />.
const th = "border border-border py-1.5 px-2 font-bold align-bottom";
const td = "border border-border py-1 px-2";

function TalukaPage({ report, taluka }: {
  report: LeakageIncentiveReport;
  taluka: LeakageIncentiveReport["talukas"][number];
}) {
  const { rule } = report;
  const posted = report.source === "posted";
  return (
    <div>
      <p className="text-center text-[13px] font-bold mb-2">{taluka.name} Taluk</p>
      <table className="w-full text-[11px] border-collapse">
        <thead>
          <tr className="bg-muted/50">
            <th className={`${th} text-right`}>Sl</th>
            <th className={`${th} text-left`}>Code</th>
            <th className={`${th} text-left`}>Customer Name</th>
            <th className={`${th} text-right`}>Milk Total<br />(Ltr)</th>
            <th className={`${th} text-right`}>Total milk as<br />incentive @ {rule.litresPer1000}<br />litre/1000 litres<br />of milk</th>
            <th className={`${th} text-right`}>Rate per<br />litre of<br />milk</th>
            <th className={`${th} text-right`}>Total<br />Incentive<br />Amount</th>
            {posted && <th className={`${th} text-left`}>Credit<br />Note No.</th>}
          </tr>
        </thead>
        <tbody>
          {taluka.rows.map(r => (
            <tr key={r.dealerId}>
              <td className={`${td} text-right num`}>{r.sl}</td>
              <td className={td}>{r.code}</td>
              <td className={td}>{r.name}</td>
              <td className={`${td} text-right num`}>{fmtLtr(r.milkLitres)}</td>
              <td className={`${td} text-right num`}>{fmt2(r.incentiveLitres)}</td>
              <td className={`${td} text-right num`}>{fmt2(rule.ratePerLitre)}</td>
              <td className={`${td} text-right num`}>{fmt2(r.amount)}</td>
              {posted && (
                <td className={`${td} ${r.reversed ? "line-through text-muted-foreground" : ""}`}>
                  {r.voucherNo ?? ""}{r.reversed ? " (reversed)" : ""}
                </td>
              )}
            </tr>
          ))}
          <tr className="font-bold bg-muted/30">
            <td className={td} />
            <td className={td} />
            <td className={td}>TOTAL</td>
            <td className={`${td} text-right num`}>{fmtLtr(taluka.totals.milkLitres)}</td>
            <td className={`${td} text-right num`}>{fmt2(taluka.totals.incentiveLitres)}</td>
            <td className={`${td} text-right num`}>{fmt2(rule.ratePerLitre)}</td>
            <td className={`${td} text-right num`}>{fmt2(taluka.totals.amount)}</td>
            {posted && <td className={td} />}
          </tr>
        </tbody>
      </table>
      <p className="text-[10px] text-muted-foreground mt-1.5">
        Total Incentive Amount is the sum of the agents' amounts, i.e. what is credited.
      </p>
    </div>
  );
}

function SummaryPage({ report }: { report: LeakageIncentiveReport }) {
  return (
    <div>
      <p className="text-center text-[13px] font-bold mb-2">All Taluks: Summary</p>
      <table className="w-full text-[11px] border-collapse">
        <thead>
          <tr className="bg-muted/50">
            <th className={`${th} text-left`}>Taluk</th>
            <th className={`${th} text-right`}>Agents</th>
            <th className={`${th} text-right`}>Milk Total<br />(Ltr)</th>
            <th className={`${th} text-right`}>Incentive<br />(Ltr)</th>
            <th className={`${th} text-right`}>Total Incentive<br />Amount</th>
          </tr>
        </thead>
        <tbody>
          {report.talukas.map(t => (
            <tr key={t.name}>
              <td className={td}>{t.name}</td>
              <td className={`${td} text-right num`}>{t.rows.length}</td>
              <td className={`${td} text-right num`}>{fmtLtr(t.totals.milkLitres)}</td>
              <td className={`${td} text-right num`}>{fmt2(t.totals.incentiveLitres)}</td>
              <td className={`${td} text-right num`}>{fmt2(t.totals.amount)}</td>
            </tr>
          ))}
          <tr className="font-bold bg-muted/30">
            <td className={td}>TOTAL</td>
            <td className={`${td} text-right num`}>{report.talukas.reduce((s, t) => s + t.rows.length, 0)}</td>
            <td className={`${td} text-right num`}>{fmtLtr(report.totals.milkLitres)}</td>
            <td className={`${td} text-right num`}>{fmt2(report.totals.incentiveLitres)}</td>
            <td className={`${td} text-right num`}>{fmt2(report.totals.amount)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// ─── Dialogs ───────────────────────────────────────────────────────
function SettingsDialog({ settings, onClose, onSaved }: {
  settings: LeakageIncentiveSettings;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [litres, setLitres] = useState(String(settings.litresPer1000));
  const [rate, setRate] = useState(String(settings.ratePerLitre));
  const [codes, setCodes] = useState<Set<string>>(new Set(settings.productCodes));
  const mut = useMutation({
    mutationFn: () => saveLeakageIncentiveSettings({
      litresPer1000: Number(litres), ratePerLitre: Number(rate), productCodes: Array.from(codes),
    }),
    onSuccess: () => { toast.success("Rule saved"); onSaved(); onClose(); },
    onError: (e: any) => toast.error(e?.message ?? "Failed"),
  });
  const toggle = (code: string) => setCodes(prev => {
    const next = new Set(prev);
    if (next.has(code)) next.delete(code); else next.add(code);
    return next;
  });
  const valid = Number(litres) > 0 && Number(rate) > 0 && codes.size > 0;
  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Leakage Incentive Rule</DialogTitle></DialogHeader>
        <div className="space-y-3 text-[13px]">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Litres per 1000 L of milk" required>
              <Input type="number" step="0.001" min="0" value={litres} onChange={e => setLitres(e.target.value)} className="erp-input" />
            </Field>
            <Field label="Rate per litre (₹)" required>
              <Input type="number" step="0.01" min="0" value={rate} onChange={e => setRate(e.target.value)} className="erp-input" />
            </Field>
          </div>
          <Field label="Products counted as milk" hint={`${codes.size} selected`}>
            <div className="max-h-64 overflow-auto border border-border rounded p-1">
              {settings.products.map(p => (
                <label key={p.code} className="flex items-center gap-2 px-2 py-1 hover:bg-muted/50 cursor-pointer">
                  <input type="checkbox" checked={codes.has(p.code)} onChange={() => toggle(p.code)} />
                  <span className="flex-1">{p.name}</span>
                  <span className="text-[11px] text-muted-foreground">{p.code}</span>
                </label>
              ))}
            </div>
          </Field>
          <p className="text-[11.5px] text-muted-foreground">
            Changes apply to statements generated from now on. Credit notes already posted keep the rule they were posted with.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" className="h-8" onClick={onClose}>Cancel</Button>
          <Button size="sm" className="h-8" disabled={!valid || mut.isPending} onClick={() => mut.mutate()}>
            {mut.isPending ? "Saving…" : "Save Rule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PostDialog({ report, today, onClose, onDone }: {
  report: LeakageIncentiveReport; today: string; onClose: () => void; onDone: () => void;
}) {
  const [voucherDate, setVoucherDate] = useState(today);
  const mut = useMutation({
    mutationFn: () => postLeakageIncentiveRun({
      from: report.from, to: report.to, voucherDate, expectedAmount: report.totals.amount,
    }),
    onSuccess: (r) => { toast.success(r.message); onDone(); onClose(); },
    onError: (e: any) => toast.error(e?.message ?? "Failed"),
  });
  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Post Leakage Incentive Credit Notes</DialogTitle></DialogHeader>
        <div className="space-y-3 text-[13px]">
          <div className="rounded border border-border p-3 space-y-1">
            <div>Period: <b>{fmtPeriod(report.from, report.to)}</b></div>
            <div>Rule: <b>{ruleText(report.rule)}</b></div>
            <div>Credit notes: <b>{report.totals.dealerCount}</b> agents, total <b>{fmtINR(report.totals.amount)}</b></div>
          </div>
          <Field label="Voucher date" required>
            <Input type="date" value={voucherDate} onChange={e => setVoucherDate(e.target.value)} className="erp-input w-44" />
          </Field>
          <p className="text-[11.5px] text-muted-foreground">
            Each agent's account is credited with their amount. This period then stays locked; reverse the run to correct it.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" className="h-8" onClick={onClose}>Cancel</Button>
          <Button size="sm" className="h-8" disabled={!voucherDate || mut.isPending} onClick={() => mut.mutate()}>
            {mut.isPending ? "Posting…" : `Post ${report.totals.dealerCount} Credit Notes`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReverseDialog({ run, onClose, onDone }: {
  run: LeakageIncentiveRunSummary; onClose: () => void; onDone: () => void;
}) {
  const [reasonText, setReasonText] = useState("");
  const mut = useMutation({
    mutationFn: () => reverseLeakageIncentiveRun(run.id, { reasonText }),
    onSuccess: (r) => { toast.success(r.message); onDone(); onClose(); },
    onError: (e: any) => toast.error(e?.message ?? "Failed"),
  });
  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Reverse Leakage Incentive Run</DialogTitle></DialogHeader>
        <div className="space-y-3 text-[13px]">
          <div className="text-muted-foreground">
            {fmtPeriod(run.periodFrom, run.periodTo)} · {run.dealerCount} credit notes · {fmtINR(run.totalAmount)}
          </div>
          <p className="text-[12px]">
            Every credit note in this run is reversed with a matching debit on the agent's account. The period can then be posted again.
          </p>
          <Field label="Reason for reversal" required hint="min 5 chars">
            <Textarea value={reasonText} onChange={e => setReasonText(e.target.value)} className="erp-input min-h-[60px]" />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" className="h-8" onClick={onClose}>Cancel</Button>
          <Button size="sm" variant="destructive" className="h-8"
            disabled={reasonText.trim().length < 5 || mut.isPending} onClick={() => mut.mutate()}>
            {mut.isPending ? "Reversing…" : "Reverse Run"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function HistoryDialog({ onClose, onOpen }: {
  onClose: () => void; onOpen: (r: LeakageIncentiveRunSummary) => void;
}) {
  const { data: runs = [], isLoading } = useQuery({
    queryKey: ["leakage-incentive-runs"],
    queryFn: fetchLeakageIncentiveRuns,
  });
  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader><DialogTitle>Leakage Incentive Runs</DialogTitle></DialogHeader>
        <div className="max-h-[60vh] overflow-auto">
          <table className="erp-table w-full text-[12px]">
            <thead>
              <tr>
                <th>Period</th><th>Voucher date</th><th className="text-right">Agents</th>
                <th className="text-right">Amount</th><th>Rule</th><th>Status</th><th>By</th><th />
              </tr>
            </thead>
            <tbody>
              {isLoading && <tr><td colSpan={8} className="text-center text-muted-foreground py-4">Loading…</td></tr>}
              {!isLoading && runs.length === 0 && (
                <tr><td colSpan={8} className="text-center text-muted-foreground py-4">No runs posted yet</td></tr>
              )}
              {runs.map(r => (
                <tr key={r.id}>
                  <td>{fmtPeriod(r.periodFrom, r.periodTo)}</td>
                  <td>{fmtDMY(r.voucherDate)}</td>
                  <td className="text-right num">{r.dealerCount}</td>
                  <td className="text-right num">{fmtINR(r.totalAmount)}</td>
                  <td>{ruleText(r)}</td>
                  <td title={r.reverseReason ?? undefined}>
                    {r.status === "posted"
                      ? <span className="text-success">Posted</span>
                      : <span className="text-destructive">Reversed</span>}
                  </td>
                  <td>{r.status === "posted" ? r.createdByName : r.reversedByName}</td>
                  <td>
                    {r.status === "posted" && (
                      <Button size="sm" variant="outline" className="h-7" onClick={() => onOpen(r)}>Open</Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </DialogContent>
    </Dialog>
  );
}
