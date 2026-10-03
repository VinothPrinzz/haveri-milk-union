// Payment-mode labels for counter sales (Recent Sales, Adhoc Sales report).
// A complimentary (VIP sample) issue is "Free".

const PAY_LABEL: Record<string, string> = {
  wallet: "Wallet", credit: "Credit", cash: "Cash", upi: "UPI", complimentary: "Free",
};

export function payModeLabel(mode?: string | null): string {
  const m = String(mode ?? "").toLowerCase();
  return PAY_LABEL[m] ?? "";
}

/** A credit pass is billed to the agent's account, not collected at the counter. */
export function isBilledMode(mode?: string | null): boolean {
  return String(mode ?? "").toLowerCase() === "credit";
}
