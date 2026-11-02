// apps/web/src/pages/dtc/RunActions.tsx
// The approval chain of a month's bills: a step timeline (who did what) and
// the buttons the signed-in user may press at the current stage.
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/PageHeader";
import { Check, CornerUpLeft, LockOpen, Send } from "lucide-react";
import { cn } from "@/lib/utils";
import { runAction, type RunAction, type RunSummary } from "@/services/dtc";
import { errMsg, fmtStamp, monthLabel, useDtcPerms } from "./shared";

const STEPS: { label: string; at: keyof RunSummary; by: keyof RunSummary }[] = [
  { label: "Prepared", at: "submittedAt", by: "submittedByName" },
  { label: "Pre-audited", at: "preAuditedAt", by: "preAuditedByName" },
  { label: "Marketing approved", at: "mktgApprovedAt", by: "mktgApprovedByName" },
  { label: "Finance approved", at: "approvedAt", by: "approvedByName" },
];

export function RunTimeline({ run, className }: { run: RunSummary; className?: string }) {
  return (
    <ol className={cn("flex flex-wrap items-stretch gap-1.5 text-[11.5px]", className)}>
      {STEPS.map((s, i) => {
        const at = run[s.at] as string | null;
        const by = run[s.by] as string | null;
        return (
          <li key={s.label} className={cn(
            "flex-1 min-w-[140px] rounded border px-2 py-1.5",
            at ? "border-success/40 bg-success/5" : "border-border bg-muted/30 text-muted-foreground",
          )}>
            <div className="flex items-center gap-1 font-medium">
              {at ? <Check className="h-3.5 w-3.5 text-success" /> : <span className="w-3.5 text-center">{i + 1}</span>}
              {s.label}
            </div>
            <div className="truncate">{at ? `${by ?? ""}, ${fmtStamp(at)}` : "Pending"}</div>
          </li>
        );
      })}
    </ol>
  );
}

interface ActionDef { action: RunAction; label: string; needsComment?: boolean; tone?: "outline" | "destructive" }

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
      if (p.approveFinance) out.push({ action: "approve", label: "Approve & lock (Finance)" }, { action: "send_back", label: "Send back", needsComment: true, tone: "outline" });
      break;
    case "approved":
      if (p.approveFinance && run.paidCount === 0) out.push({ action: "reopen", label: "Reopen", needsComment: true, tone: "outline" });
      break;
  }
  return out;
}

export function RunActionButtons({ run, onDone, size = "sm" }: { run: RunSummary; onDone?: () => void; size?: "sm" | "xs" }) {
  const qc = useQueryClient();
  const actions = useRunActions(run);
  const [commentFor, setCommentFor] = useState<ActionDef | null>(null);
  const [comment, setComment] = useState("");
  const mut = useMutation({
    mutationFn: ({ action, comment }: { action: RunAction; comment?: string }) => runAction(run.id, action, comment),
    onSuccess: (r) => {
      toast.success(r.message);
      setCommentFor(null);
      setComment("");
      qc.invalidateQueries({ queryKey: ["dtc-runs"] });
      qc.invalidateQueries({ queryKey: ["dtc-run"] });
      qc.invalidateQueries({ queryKey: ["dtc-bill"] });
      qc.invalidateQueries({ queryKey: ["dtc-pending-payments"] });
      onDone?.();
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  if (actions.length === 0) return null;
  const h = size === "xs" ? "h-7 text-[12px]" : "h-8";
  return (
    <>
      {actions.map(a => (
        <Button key={a.action} size="sm" variant={a.tone ?? "default"} className={h} disabled={mut.isPending}
          onClick={() => {
            if (a.needsComment) { setCommentFor(a); return; }
            if (a.action === "approve" && !confirm(`Approve and lock the ${monthLabel(run.month)} bills? They can then be paid, and no longer edited.`)) return;
            mut.mutate({ action: a.action });
          }}>
          {a.action === "send_back" ? <CornerUpLeft className="h-3.5 w-3.5 mr-1.5" />
            : a.action === "reopen" ? <LockOpen className="h-3.5 w-3.5 mr-1.5" />
            : a.action === "submit" ? <Send className="h-3.5 w-3.5 mr-1.5" />
            : <Check className="h-3.5 w-3.5 mr-1.5" />}
          {a.label}
        </Button>
      ))}
      {commentFor && (
        <Dialog open onOpenChange={v => { if (!v) setCommentFor(null); }}>
          <DialogContent className="max-w-md">
            <DialogHeader><DialogTitle>{commentFor.label}: {monthLabel(run.month)}</DialogTitle></DialogHeader>
            <div className="space-y-2 text-[13px]">
              <p className="text-muted-foreground">
                {commentFor.action === "reopen"
                  ? "The bills go back to draft so Marketing can correct them, and the approvals start again."
                  : "The bills go back to draft with your comment, so Marketing can correct them and submit again."}
              </p>
              <Field label="What needs correcting" required hint="min 5 chars">
                <Textarea autoFocus value={comment} onChange={e => setComment(e.target.value)} className="erp-input min-h-[80px]" />
              </Field>
            </div>
            <DialogFooter>
              <Button variant="outline" size="sm" className="h-8" onClick={() => setCommentFor(null)}>Cancel</Button>
              <Button size="sm" className="h-8" disabled={comment.trim().length < 5 || mut.isPending}
                onClick={() => mut.mutate({ action: commentFor.action, comment })}>
                {mut.isPending ? "Saving…" : commentFor.label}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
