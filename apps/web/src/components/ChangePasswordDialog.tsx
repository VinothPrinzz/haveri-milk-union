// Self-service change-password dialog for the logged-in admin.
// Verifies the current password on the server before updating.
import { useState } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Eye, EyeOff, KeyRound } from "lucide-react";
import { changeAdminPassword } from "@/lib/auth";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const MIN_LEN = 6;

export function ChangePasswordDialog({ open, onOpenChange }: Props) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const reset = () => {
    setCurrent(""); setNext(""); setConfirm(""); setShow(false); setSubmitting(false);
  };

  const handleOpenChange = (o: boolean) => {
    if (!o) reset();
    onOpenChange(o);
  };

  // Client-side validation mirrors the server rules for instant feedback.
  const error =
    next && next.length < MIN_LEN
      ? `New password must be at least ${MIN_LEN} characters`
      : next && confirm && next !== confirm
      ? "New passwords do not match"
      : current && next && current === next
      ? "New password must be different from your current password"
      : "";

  const canSubmit =
    !!current && next.length >= MIN_LEN && next === confirm && current !== next && !submitting;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await changeAdminPassword(current, next);
      toast.success("Password changed successfully");
      handleOpenChange(false);
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to change password");
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-4 w-4" /> Change Password
          </DialogTitle>
          <DialogDescription>
            Enter your current password, then choose a new one. Your other active
            sessions will be signed out.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-3">
          <div className="space-y-1">
            <label className="text-[12px] font-medium text-foreground">Current password</label>
            <Input
              type={show ? "text" : "password"}
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              className="erp-input"
              autoFocus
            />
          </div>

          <div className="space-y-1">
            <label className="text-[12px] font-medium text-foreground">New password</label>
            <div className="relative">
              <Input
                type={show ? "text" : "password"}
                autoComplete="new-password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
                className="erp-input pr-9"
              />
              <button
                type="button"
                onClick={() => setShow((s) => !s)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                title={show ? "Hide" : "Show"}
                tabIndex={-1}
              >
                {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-[12px] font-medium text-foreground">Confirm new password</label>
            <Input
              type={show ? "text" : "password"}
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className="erp-input"
            />
          </div>

          {error && <p className="text-[12px] text-destructive">{error}</p>}

          <DialogFooter className="pt-2">
            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {submitting ? "Saving…" : "Change Password"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
