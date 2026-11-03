// apps/web/src/pages/dtc/RunActions.tsx
// The approval chain of a month's bills: the status pipeline (who did what)
// and the buttons the signed-in user may press at the current stage. A
// reason (send back / reopen) or the final approval opens in place, under
// the buttons, rather than in a pop-up.
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Check, CornerUpLeft, LockOpen, Send } from "lucide-react";
import { cn } from "@/lib/utils";
import { runAction, type RunAction, type RunSummary } from "@/services/dtc";
import { errMsg, fmtStamp, monthLong, useDtcPerms } from "./shared";
import { InlinePanel, StatusPipeline } from "./ui";

const STEPS: { label: string; at: keyof RunSummary; by: keyof RunSummary }[] = [
  { label: "Prepared", at: "submittedAt", by: "submittedByName" },
  { label: "Pre-audited", at: "preAuditedAt", by: "preAuditedByName" },
  { label: "Marketing approved", at: "mktgApprovedAt", by: "mktgApprovedByName" },
  { label: "Finance approved", at: "approvedAt", by: "approvedByName" },
];

/** Draft → … → Approved, as a pipeline (Odoo-style status bar). */
export function RunPipeline({ run, className }: { run: RunSummary; className?: string }) {
  return (
    <StatusPipeline
      className={className}
      current={run.status}
      steps={[
        { key: "draft", label: "Draft" },
        { key: "submitted", label: "Pre-audit" },
        { key: "pre_audited", label: "Marketing approval" },
        { key: "mktg_approved", label: "Finance approval" },
        { key: "approved", label: "Approved" },
      ]}
    />
  );
}

/** Who signed each step, and when. */
export function RunTimeline({ run, className }: { run: RunSummary; className?: string }) {
  return (
    <ol className={cn("grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-[12px]", className)}>
      {STEPS.map(s => {
        const at = run[s.at] as string | null;
        const by = run[s.by] as string | null;
        return (
          <li key={s.label} className={cn("flex items-start gap-1.5", !at && "text-muted-foreground")}>
            {at ? <Check className="h-3.5 w-3.5 text-success mt-0.5 shrink-0" /> : <span className="h-3.5 w-3.5 mt-0.5 shrink-0 rounded-full border border-border" />}
            <span className="min-w-0">
              <span className="font-medium">{s.label}</span>
              <span className="block">{at ? `${by ?? ""} · ${fmtStamp(at)}` : "Pending"}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

interface ActionDef { action: RunAction; label: string; needsComment?: boolean; confirm?: string; tone?: "outline" }

/** What the current user can do with the run at its current stage. */
export function useRunActions(run: RunSummary): ActionDef[] {
  const p = useDtcPerms();
  const out: ActionDef[] = [];
  switch (run.status) {
    case "draft":
      if (p.prepare && run.billCount > 0) out.push({ action: "submit", label: "Submit for pre-audit" });
      break;
    case "submitted":
      if (p.audit) out.push({ action: "pre_audit", label: "Pre-audit OK" }, { action: "send_back", label: "Send back", needsComment: true, tone: "outline" });
      break;
    case "pre_audited":
      if (p.approveMktg) out.push({ action: "mktg_approve", label: "Approve (Marketing)" }, { action: "send_back", label: "Send back", needsComment: true, tone: "outline" });
      break;
    case "mktg_approved":
      if (p.approveFinance) out.push(
        { action: "approve", label: "Approve & lock (Finance)", confirm: "The bills are locked and can be paid. They can't be edited after this." },
        { action: "send_back", label: "Send back", needsComment: true, tone: "outline" },
      );
      break;
    case "approved":
      if (p.approveFinance && run.paidCount === 0) out.push({ action: "reopen", label: "Reopen for correction", needsComment: true, tone: "outline" });
      break;
  }
  return out;
}

/** Action buttons with the reason / confirmation panel opening in place below them. */
export function RunActionArea({ run, onDone, compact }: { run: RunSummary; onDone?: () => void; compact?: boolean }) {
  const qc = useQueryClient();
  const actions = useRunActions(run);
  const [pending, setPending] = useState<ActionDef | null>(null);
  const [comment, setComment] = useState("");
  const mut = useMutation({
    mutationFn: ({ action, comment }: { action: RunAction; comment?: string }) => runAction(run.id, action, comment),
    onSuccess: (r) => {
      toast.success(r.message);
      setPending(null);
      setComment("");
      ["dtc-runs", "dtc-run", "dtc-bill", "dtc-pending-payments"].forEach(k => qc.invalidateQueries({ queryKey: [k] }));
      onDone?.();
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  if (actions.length === 0) return null;
  const h = compact ? "h-7 text-[12px]" : "h-8";
  return (
    <div className="space-y-2 w-full">
      <div className="flex flex-wrap items-center gap-1.5 justify-end">
        {actions.map(a => (
          <Button key={a.action} size="sm" variant={a.tone ?? "default"} className={h} disabled={mut.isPending}
            onClick={() => {
              if (a.needsComment || a.confirm) { setPending(pending?.action === a.action ? null : a); return; }
              mut.mutate({ action: a.action });
            }}>
            {a.action === "send_back" ? <CornerUpLeft className="h-3.5 w-3.5 mr-1.5" />
              : a.action === "reopen" ? <LockOpen className="h-3.5 w-3.5 mr-1.5" />
              : a.action === "submit" ? <Send className="h-3.5 w-3.5 mr-1.5" />
              : <Check className="h-3.5 w-3.5 mr-1.5" />}
            {a.label}
          </Button>
        ))}
      </div>
      <InlinePanel
        open={!!pending}
        tone={pending?.action === "approve" ? "default" : "warning"}
        title={pending ? `${pending.label}: ${monthLong(run.month)}` : ""}
      >
        {pending?.confirm && <p className="text-[12.5px]">{pending.confirm}</p>}
        {pending?.needsComment && (
          <>
            <p className="text-[12.5px] text-muted-foreground">
              {pending.action === "reopen"
                ? "The bills go back to draft so Marketing can correct them; the approvals start again."
                : "The bills go back to draft with your note, so Marketing can correct them and submit again."}
            </p>
            <Textarea autoFocus value={comment} onChange={e => setComment(e.target.value)} placeholder="What needs correcting (at least 5 characters)" className="erp-input min-h-[70px]" />
          </>
        )}
        <div className="flex justify-end gap-1.5">
          <Button size="sm" variant="ghost" className="h-8" onClick={() => { setPending(null); setComment(""); }}>Cancel</Button>
          <Button size="sm" className="h-8"
            disabled={mut.isPending || (!!pending?.needsComment && comment.trim().length < 5)}
            onClick={() => pending && mut.mutate({ action: pending.action, comment: pending.needsComment ? comment : undefined })}>
            {mut.isPending ? "Saving…" : pending?.label}
          </Button>
        </div>
      </InlinePanel>
    </div>
  );
}
