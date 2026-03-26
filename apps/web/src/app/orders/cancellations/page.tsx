"use client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { formatCurrency, cn } from "@/lib/utils";
import { PageHeader, Badge, Button } from "@/components/ui";
import { Check, X, Clock } from "lucide-react";

// Mock data until the cancellation list API endpoint is built
const MOCK_CANCELLATIONS = [
  { id: "1", orderId: "#HMU-2025-08471", status: "pending", dealerName: "Raju Agencies", location: "Haveri", items: "Full Cream Milk x15, Butter x4", reason: "Ordered wrong quantity", timeAgo: "10 min ago", amount: "933" },
  { id: "2", orderId: "#HMU-2025-08390", status: "pending", dealerName: "Krishna Stores", location: "Ranebennur", items: "Toned Milk x20, Curd x10", reason: "Shop closed tomorrow", timeAgo: "25 min ago", amount: "820" },
  { id: "3", orderId: "#HMU-2025-08310", status: "approved", dealerName: "Laxmi Traders", location: "Savanur", items: "Ghee x5", reason: "Duplicate order", timeAgo: "1 hr ago", amount: "1400" },
  { id: "4", orderId: "#HMU-2025-08205", status: "rejected", dealerName: "Ganesh Dairy", location: "Byadgi", items: "Paneer x10", reason: "Price mismatch", timeAgo: "2 hrs ago", amount: "950" },
];

export default function CancellationRequestsPage() {
  const pendingCount = MOCK_CANCELLATIONS.filter((c) => c.status === "pending").length;

  return (
    <>
      <PageHeader
        icon="❌"
        title="Cancellation Requests"
        subtitle="Review and process indent cancellation requests"
        actions={
          <Badge variant="pending" className="text-[11px] px-3 py-1">
            {pendingCount} Pending
          </Badge>
        }
      />

      <div className="space-y-3">
        {MOCK_CANCELLATIONS.map((c) => {
          const isPending = c.status === "pending";
          return (
            <div
              key={c.id}
              className={cn(
                "bg-card rounded-[10px] border shadow-card p-4",
                isPending ? "border-warning/30" : "border-border",
                !isPending && "opacity-60"
              )}
            >
              <div className="flex items-start justify-between gap-4">
                {/* Left content */}
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-display text-[13px] font-bold text-fg">{c.orderId}</span>
                    <Badge variant={c.status}>{c.status}</Badge>
                  </div>
                  <div className="text-[11px] text-muted-fg font-medium space-y-0.5">
                    <div>{c.dealerName} · {c.location}</div>
                    <div>{c.items}</div>
                    <div>Reason: {c.reason}</div>
                    <div className="flex items-center gap-1.5 mt-1">
                      <Clock className="h-3 w-3" />
                      {c.timeAgo} · <strong className="text-fg">{formatCurrency(c.amount)}</strong>
                    </div>
                  </div>
                </div>

                {/* Right actions — only for pending */}
                {isPending && (
                  <div className="flex items-center gap-2 shrink-0">
                    <Button variant="outline" size="sm" className="text-success border-success/30 hover:bg-success/10">
                      <Check className="h-3.5 w-3.5" /> Approve
                    </Button>
                    <Button variant="outline" size="sm" className="text-danger border-danger/30 hover:bg-danger/10">
                      <X className="h-3.5 w-3.5" /> Reject
                    </Button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
