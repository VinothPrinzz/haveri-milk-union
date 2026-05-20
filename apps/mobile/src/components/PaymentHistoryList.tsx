import React from "react";
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { colors, fonts } from "../lib/theme";
import {
  usePaymentHistory,
  type RazorpayPaymentRow,
} from "../hooks/usePaymentHistory";

/**
 * PaymentHistoryList — recent Razorpay transactions, newest first.
 *
 * Drop into ProfileScreen below the ProfileFinanceCard.
 *
 * Each row shows:
 *   • Status icon (✓ paid, ⊘ failed, ⏳ created/attempted)
 *   • Date + kind ("Credit top-up" or "Order payment")
 *   • Amount + status label
 *
 * Tapping a row could navigate to the order detail (for order_payment)
 * but for Phase 4 this is informational only.
 */

export default function PaymentHistoryList() {
  const { data, isLoading, isError } = usePaymentHistory();

  if (isLoading) {
    return (
      <View style={styles.empty}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  if (isError) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyText}>
          Couldn't load payment history. Pull to refresh.
        </Text>
      </View>
    );
  }

  const payments = data ?? [];
  if (payments.length === 0) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyEmoji}>💳</Text>
        <Text style={styles.emptyTitle}>No payments yet</Text>
        <Text style={styles.emptyText}>
          Top-ups and direct order payments will appear here.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.list}>
      {payments.map((p, idx) => (
        <PaymentRow
          key={p.id}
          payment={p}
          isLast={idx === payments.length - 1}
        />
      ))}
    </View>
  );
}

function PaymentRow({
  payment,
  isLast,
}: {
  payment: RazorpayPaymentRow;
  isLast: boolean;
}) {
  const variant = statusVariant(payment.status);
  const dateStr = formatDate(payment.paidAt ?? payment.createdAt);
  const kindLabel =
    payment.kind === "credit_topup" ? "Credit top-up" : "Order payment";

  return (
    <View style={[styles.row, isLast && styles.rowLast]}>
      <View style={[styles.icon, { backgroundColor: variant.bg }]}>
        <Text style={[styles.iconText, { color: variant.color }]}>
          {variant.symbol}
        </Text>
      </View>
      <View style={styles.body}>
        <Text style={styles.label}>{kindLabel}</Text>
        <Text style={styles.meta}>{dateStr}</Text>
      </View>
      <View style={styles.right}>
        <Text style={styles.amount}>
          ₹{payment.amount.toLocaleString("en-IN", { minimumFractionDigits: 2 })}
        </Text>
        <Text style={[styles.statusLabel, { color: variant.color }]}>
          {statusLabel(payment.status)}
        </Text>
      </View>
    </View>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────

function statusLabel(status: RazorpayPaymentRow["status"]): string {
  switch (status) {
    case "paid": return "Paid";
    case "failed": return "Failed";
    case "refunded": return "Refunded";
    case "created":
    case "attempted":
      return "Pending";
    default: return status;
  }
}

function statusVariant(status: RazorpayPaymentRow["status"]): {
  symbol: string;
  bg: string;
  color: string;
} {
  switch (status) {
    case "paid":
      return { symbol: "✓", bg: "#DCFCE7", color: "#166534" };
    case "failed":
      return { symbol: "✕", bg: "#FEE2E2", color: "#A32D2D" };
    case "refunded":
      return { symbol: "↶", bg: colors.background, color: colors.mutedForeground };
    case "created":
    case "attempted":
    default:
      return { symbol: "⋯", bg: "#FAEEDA", color: "#92400E" };
  }
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const day = d.getDate();
  const month = d.toLocaleDateString("en-IN", { month: "short" });
  const year = d.getFullYear();
  const time = d.toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
  return `${day} ${month} ${year} · ${time}`;
}

// ════════════════════════════════════════════════════════════════════
// Styles
// ════════════════════════════════════════════════════════════════════

const styles = StyleSheet.create({
  list: {
    marginHorizontal: 12,
    backgroundColor: colors.card,
    borderRadius: 6,
    borderWidth: 0.5,
    borderColor: colors.border,
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 11,
    paddingHorizontal: 12,
    gap: 11,
    borderBottomWidth: 0.5,
    borderBottomColor: colors.border,
  },
  rowLast: { borderBottomWidth: 0 },
  icon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  iconText: {
    fontSize: 16,
    fontFamily: fonts.extrabold,
  },
  body: { flex: 1 },
  label: {
    fontSize: 12,
    fontFamily: fonts.semibold,
    color: colors.foreground,
  },
  meta: {
    fontSize: 11,
    fontFamily: fonts.medium,
    color: colors.mutedForeground,
    marginTop: 1,
  },
  right: { alignItems: "flex-end" },
  amount: {
    fontSize: 13,
    fontFamily: fonts.bold,
    color: colors.foreground,
  },
  statusLabel: {
    fontSize: 11,
    fontFamily: fonts.semibold,
    marginTop: 1,
  },

  empty: {
    padding: 24,
    alignItems: "center",
    marginHorizontal: 12,
    backgroundColor: colors.card,
    borderRadius: 6,
    borderWidth: 0.5,
    borderColor: colors.border,
  },
  emptyEmoji: { fontSize: 32 },
  emptyTitle: {
    fontSize: 13,
    fontFamily: fonts.bold,
    color: colors.foreground,
    marginTop: 8,
  },
  emptyText: {
    fontSize: 11,
    fontFamily: fonts.medium,
    color: colors.mutedForeground,
    marginTop: 4,
    textAlign: "center",
    lineHeight: 16,
  },
});