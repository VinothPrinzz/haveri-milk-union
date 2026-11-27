// apps/web/src/lib/financeAccess.ts
// Who may change anything in the Finance module: Finance (accountant) and
// super_admin. Mirrors finance.manage in apps/api/src/middleware/admin-auth.ts,
// which is strict there (the call_desk super role does not get it).
// Everyone else who can open Finance reads only.
import { useAuth } from "@/lib/auth";

export const FINANCE_EDIT_ROLES = new Set(["accountant", "super_admin"]);

export function useCanEditFinance(): boolean {
  const { user } = useAuth();
  return FINANCE_EDIT_ROLES.has(user?.role ?? "");
}

export const FINANCE_READ_ONLY_NOTE = "You have read-only access. Only Finance users can make changes here.";
