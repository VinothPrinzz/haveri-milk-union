import React, { useState, useMemo, useEffect } from "react";
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { colors, fonts } from "../lib/theme";
import AppHeader from "../components/AppHeader";
import { useAuthStore } from "../store/auth";
import { useNotifications } from "../hooks/useNotifications";
import { useWindowStatus } from "../hooks/useWindow";
import { useOrderPayment } from "../hooks/useOrderPayment";
import {
  addDaysIst,
  istTodayIso,
  relativeLabel,
  useTargetDateStore,
} from "../store/targetDate";
import {
  useConfirmDraft,
  useDailyDraft,
  usePatchDraft,
  isCreditExceededError,
} from "../hooks/useDailyDraft";
import type { ConfirmDraftCreditExceeded, DraftItem } from "../lib/types";
import TopUpSheet from "../components/TopUpSheet";
import { RazorpayCancelled } from "../hooks/useOrderPayment";

/**
 * IndentScreen v2 — wired to the real per-date draft API.
 * Phase 2B: Top-up sheet + Pay-now Razorpay flow added.
 */

interface IndentScreenProps {
  onOpenNotifications: () => void;
  onOpenProfile: () => void;
  onOpenManageStanding: () => void;
}

function buildDateChips(): string[] {
  const today = istTodayIso();
  return [today, ...Array.from({ length: 5 }, (_, i) => addDaysIst(today, i + 1))];
}

export default function IndentScreen({
  onOpenNotifications,
  onOpenProfile,
  onOpenManageStanding,
}: IndentScreenProps) {
  const dealer = useAuthStore((s) => s.dealer);
  const { data: notifs } = useNotifications();
  const windowQuery = useWindowStatus(dealer?.zoneId);
  const selectedDate = useTargetDateStore((s) => s.selectedDate);
  const setSelectedDate = useTargetDateStore((s) => s.setSelectedDate);
  const draftQuery = useDailyDraft(selectedDate);
  const patchDraft = usePatchDraft(selectedDate);
  const confirmDraft = useConfirmDraft(selectedDate);

  // Phase 2B additions
  const [showTopUp, setShowTopUp] = useState(false);
  const [shortfall, setShortfall] = useState<number | undefined>(undefined);
  const [payNowOrderId, setPayNowOrderId] = useState<string | null>(null);
  const orderPayment = useOrderPayment(payNowOrderId ?? "");

  const dateChips = useMemo(buildDateChips, []);
  const isToday = selectedDate === istTodayIso();
  const windowState = windowQuery.data?.state ?? "closed";
  const unreadNotifications = (notifs ?? []).some((n) => n.unread);
  const draft = draftQuery.data;
  const isPaused = draft?.paused ?? false;
  const isLoading = draftQuery.isLoading || !draft;
  const items = draft?.items ?? [];
  const totals = draft?.totals ?? { subtotal: 0, totalGst: 0, grandTotal: 0 };
  const isPaymentRequired = draft?.status === "payment_required";

  // Pay-now effect
  useEffect(() => {
    if (!payNowOrderId) return;

    let cancelled = false;
    (async () => {
      try {
        await orderPayment.mutateAsync();
        if (!cancelled) {
          Alert.alert(
            "Order paid",
            `Your order is confirmed for ${relativeLabel(selectedDate)}.`
          );
        }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof RazorpayCancelled) return;
        Alert.alert(
          "Payment failed",
          err instanceof Error ? err.message : "Please try again."
        );
      } finally {
        if (!cancelled) setPayNowOrderId(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [payNowOrderId, orderPayment, selectedDate]);

  // ── Status banner ──
  const statusBanner = useMemo(() => {
    if (isPaused) {
      return {
        kind: "closed" as const,
        text: `Shop is paused for this date${
          draft?.pausedReason ? ` · ${draft.pausedReason}` : ""
        }`,
      };
    }
    if (isPaymentRequired) {
      return {
        kind: "warning" as const,
        text: "Payment required — your credit limit was exceeded",
      };
    }
    if (!isToday) {
      return {
        kind: "future" as const,
        text: "Editable anytime · auto-confirms at window close on this date",
      };
    }
    if (windowState === "closed") {
      return { kind: "closed" as const, text: "Today's window is closed" };
    }
    const min = Math.ceil((windowQuery.data?.remainingSeconds ?? 0) / 60);
    return {
      kind: windowState === "warning" ? ("warning" as const) : ("open" as const),
      text: `Closes in ${min} minute${min === 1 ? "" : "s"}`,
    };
  }, [
    isPaused,
    isPaymentRequired,
    isToday,
    windowState,
    windowQuery.data?.remainingSeconds,
    draft?.pausedReason,
  ]);

  // ── Item +/- handlers ──
  const updateItemQty = (productId: string, delta: number) => {
    if (isPaused) return;
    const current = items.find((i) => i.productId === productId);
    const newQty = Math.max(0, (current?.quantity ?? 0) + delta);
    const nextItems = items
      .map((i) => ({
        productId: i.productId,
        quantity: i.productId === productId ? newQty : i.quantity,
      }))
      .filter((i) => i.quantity > 0);

    if (!current && newQty > 0) {
      nextItems.push({ productId, quantity: newQty });
    }
    patchDraft.mutate(nextItems);
  };

  // ── Updated Confirm handler (Phase 2B) ──
  const handleConfirm = async () => {
    try {
      const result = await confirmDraft.mutateAsync({ paymentMode: "credit" });
      Alert.alert(
        "Indent confirmed",
        `Order placed for ${relativeLabel(result.deliveryDate)}.`
      );
    } catch (err) {
      if (isCreditExceededError(err)) {
        const body = err.body as ConfirmDraftCreditExceeded;
        Alert.alert(
          "Credit limit exceeded",
          `Short by ₹${body.credit.shortfall.toFixed(2)}. Choose how to proceed:`,
          [
            { text: "Cancel", style: "cancel" },
            {
              text: "Top up credit",
              onPress: () => {
                setShortfall(body.credit.shortfall);
                setShowTopUp(true);
              },
            },
            {
              text: "Pay this order now",
              onPress: () => setPayNowOrderId(body.orderId),
            },
          ]
        );
        return;
      }
      Alert.alert(
        "Could not confirm",
        err instanceof Error ? err.message : "Please try again."
      );
    }
  };

  if (!dealer) return null;

  return (
    <View style={styles.root}>
      <AppHeader
        title="My indent"
        subtitle="Edit, confirm, schedule ahead"
        unreadNotifications={unreadNotifications}
        onBellPress={onOpenNotifications}
        onProfilePress={onOpenProfile}
      />

      {/* Date strip */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.dateStrip}
      >
        {dateChips.map((d) => {
          const active = d === selectedDate;
          return (
            <TouchableOpacity
              key={d}
              activeOpacity={0.75}
              onPress={() => setSelectedDate(d)}
              style={[styles.dateChip, active && styles.dateChipActive]}
            >
              <Text
                style={[
                  styles.dateChipText,
                  active && styles.dateChipTextActive,
                ]}
              >
                {relativeLabel(d)}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      <ScrollView
        style={styles.body}
        contentContainerStyle={styles.bodyContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Status banner */}
        <View style={[styles.banner, BANNER_STYLES[statusBanner.kind].wrap]}>
          <Text style={[styles.bannerText, BANNER_STYLES[statusBanner.kind].text]}>
            {statusBanner.text}
          </Text>
        </View>

        {/* Loading */}
        {isLoading && !draft && (
          <View style={styles.loading}>
            <ActivityIndicator color={colors.primary} />
          </View>
        )}

        {/* Items section */}
        {!isLoading && (
          <>
            <View style={styles.sectionHeaderRow}>
              <Text style={styles.sectionTitle}>
                Items for {relativeLabel(selectedDate)}
              </Text>
              {!isPaused && (
                <TouchableOpacity activeOpacity={0.6} onPress={onOpenManageStanding}>
                  <Text style={styles.manageLink}>Manage standing indent</Text>
                </TouchableOpacity>
              )}
            </View>

            {items.length > 0 ? (
              <View style={styles.itemsCard}>
                {items.map((it, idx) => (
                  <DraftRow
                    key={it.productId}
                    item={it}
                    isLast={idx === items.length - 1}
                    disabled={isPaused}
                    onIncrement={() => updateItemQty(it.productId, 1)}
                    onDecrement={() => updateItemQty(it.productId, -1)}
                  />
                ))}
              </View>
            ) : (
              <View style={styles.empty}>
                <Text style={styles.emptyEmoji}>📋</Text>
                <Text style={styles.emptyTitle}>No items yet</Text>
                <Text style={styles.emptySub}>
                  {isPaused
                    ? "Resume your standing indent to start ordering again."
                    : `Add products from the Home tab — they'll show up here for ${relativeLabel(
                        selectedDate
                      )}.`}
                </Text>
              </View>
            )}

            {/* Summary + payment + confirm */}
            {items.length > 0 && !isPaused && (
              <>
                <View style={styles.summary}>
                  <Row
                    label="Subtotal"
                    value={`₹${totals.subtotal.toFixed(2)}`}
                  />
                  <Row label="GST" value={`₹${totals.totalGst.toFixed(2)}`} />
                  <View style={styles.summaryDivider} />
                  <Row
                    label="Total"
                    value={`₹${totals.grandTotal.toFixed(2)}`}
                    emphasis
                  />
                </View>

                {/* Payment selector */}
                <View style={styles.payCard}>
                  <View style={styles.payHeader}>
                    <View style={styles.radioOn} />
                    <Text style={styles.payLabel}>Use credit limit</Text>
                    <Text style={styles.payAvail}>
                      ₹{(dealer.creditLimit ?? 0).toFixed(0)} limit
                    </Text>
                  </View>
                </View>

                <TouchableOpacity
                  activeOpacity={0.8}
                  onPress={handleConfirm}
                  disabled={confirmDraft.isPending}
                  style={[
                    styles.confirmBtn,
                    confirmDraft.isPending && styles.confirmBtnDisabled,
                  ]}
                >
                  {confirmDraft.isPending ? (
                    <ActivityIndicator color={colors.primaryForeground} />
                  ) : (
                    <Text style={styles.confirmBtnText}>
                      Confirm indent for {relativeLabel(selectedDate)}
                    </Text>
                  )}
                </TouchableOpacity>
              </>
            )}
          </>
        )}
      </ScrollView>

      {/* Phase 2B: TopUpSheet */}
      <TopUpSheet
        visible={showTopUp}
        suggestedAmount={shortfall}
        onClose={() => setShowTopUp(false)}
        onSuccess={(paid) => {
          setShowTopUp(false);
          Alert.alert(
            "Top-up successful",
            `₹${paid.toLocaleString("en-IN")} credited to your account. You can retry confirming the order now.`
          );
        }}
      />
    </View>
  );
}

// ── Sub-components ────────────────────────────────────────────────

function DraftRow({
  item,
  isLast,
  disabled,
  onIncrement,
  onDecrement,
}: {
  item: DraftItem;
  isLast: boolean;
  disabled: boolean;
  onIncrement: () => void;
  onDecrement: () => void;
}) {
  return (
    <View style={[styles.itemRow, isLast && styles.itemRowLast]}>
      <View style={styles.itemThumb}>
        <Text style={styles.itemThumbText}>{item.icon ?? "📦"}</Text>
      </View>
      <View style={styles.itemBody}>
        <Text style={styles.itemName} numberOfLines={1}>
          {item.productName}
        </Text>
        <Text style={styles.itemMeta}>
          ₹{item.unitPrice.toFixed(2)} · {item.unit}
        </Text>
      </View>
      <View style={[styles.itemStepper, disabled && styles.itemStepperDisabled]}>
        <TouchableOpacity
          onPress={onDecrement}
          activeOpacity={0.7}
          disabled={disabled}
          style={styles.itemStepBtn}
        >
          <Text style={styles.itemStepIcon}>−</Text>
        </TouchableOpacity>
        <Text style={styles.itemStepVal}>{item.quantity}</Text>
        <TouchableOpacity
          onPress={onIncrement}
          activeOpacity={0.7}
          disabled={disabled}
          style={styles.itemStepBtn}
        >
          <Text style={styles.itemStepIcon}>+</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function Row({ label, value, emphasis }: any) {
  return (
    <View style={styles.summaryRow}>
      <Text style={emphasis ? styles.summaryTotalLabel : styles.summaryLabel}>
        {label}
      </Text>
      <Text style={emphasis ? styles.summaryTotalValue : styles.summaryValue}>
        {value}
      </Text>
    </View>
  );
}

// ════════════════════════════════════════════════════════════════════
// Styles
// ════════════════════════════════════════════════════════════════════

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },

  // Date strip
  dateStrip: {
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 4,
    gap: 6,
  },
  dateChip: {
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: 0.5,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  dateChipActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  dateChipText: {
    fontSize: 11,
    fontFamily: fonts.semibold,
    color: colors.foreground,
  },
  dateChipTextActive: { color: colors.primaryForeground },

  body: { flex: 1 },
  bodyContent: { paddingBottom: 32 },

  // Banner
  banner: {
    marginHorizontal: 12,
    marginTop: 10,
    padding: 9,
    borderRadius: 6,
    borderWidth: 0.5,
  },
  bannerText: { fontSize: 11, fontFamily: fonts.semibold },

  // Loading
  loading: { paddingVertical: 60 },

  // Section header
  sectionHeaderRow: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 6,
  },
  sectionTitle: {
    fontSize: 13,
    fontFamily: fonts.bold,
    color: colors.foreground,
  },
  manageLink: {
    fontSize: 11,
    fontFamily: fonts.semibold,
    color: colors.primary,
  },

  // Items card
  itemsCard: {
    marginHorizontal: 12,
    backgroundColor: colors.card,
    borderRadius: 6,
    borderWidth: 0.5,
    borderColor: colors.border,
    overflow: "hidden",
  },
  itemRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 9,
    paddingHorizontal: 11,
    gap: 10,
    borderBottomWidth: 0.5,
    borderBottomColor: colors.border,
  },
  itemRowLast: { borderBottomWidth: 0 },
  itemThumb: {
    width: 32,
    height: 32,
    borderRadius: 4,
    backgroundColor: colors.background,
    alignItems: "center",
    justifyContent: "center",
  },
  itemThumbText: { fontSize: 16 },
  itemBody: { flex: 1 },
  itemName: {
    fontSize: 12,
    fontFamily: fonts.semibold,
    color: colors.foreground,
  },
  itemMeta: {
    fontSize: 11,
    fontFamily: fonts.medium,
    color: colors.mutedForeground,
    marginTop: 1,
  },
  itemStepper: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.primaryLight,
    borderRadius: 4,
    overflow: "hidden",
  },
  itemStepperDisabled: { opacity: 0.4 },
  itemStepBtn: {
    width: 24,
    height: 26,
    alignItems: "center",
    justifyContent: "center",
  },
  itemStepIcon: {
    fontSize: 14,
    fontFamily: fonts.bold,
    color: colors.primary,
  },
  itemStepVal: {
    minWidth: 22,
    textAlign: "center",
    fontSize: 12,
    fontFamily: fonts.extrabold,
    color: colors.primary,
  },

  // Empty
  empty: {
    marginHorizontal: 12,
    paddingVertical: 40,
    paddingHorizontal: 16,
    backgroundColor: colors.card,
    borderRadius: 6,
    borderWidth: 0.5,
    borderColor: colors.border,
    alignItems: "center",
  },
  emptyEmoji: { fontSize: 32 },
  emptyTitle: {
    fontSize: 13,
    fontFamily: fonts.bold,
    color: colors.foreground,
    marginTop: 10,
  },
  emptySub: {
    fontSize: 11,
    fontFamily: fonts.medium,
    color: colors.mutedForeground,
    marginTop: 4,
    textAlign: "center",
    lineHeight: 16,
  },

  // Summary
  summary: {
    marginHorizontal: 12,
    marginTop: 12,
    padding: 11,
    backgroundColor: colors.card,
    borderRadius: 6,
    borderWidth: 0.5,
    borderColor: colors.border,
  },
  summaryRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 3,
  },
  summaryLabel: {
    fontSize: 11,
    fontFamily: fonts.medium,
    color: colors.mutedForeground,
  },
  summaryValue: {
    fontSize: 12,
    fontFamily: fonts.semibold,
    color: colors.foreground,
  },
  summaryDivider: {
    height: 0.5,
    backgroundColor: colors.border,
    marginVertical: 6,
  },
  summaryTotalLabel: {
    fontSize: 13,
    fontFamily: fonts.bold,
    color: colors.foreground,
  },
  summaryTotalValue: {
    fontSize: 14,
    fontFamily: fonts.bold,
    color: colors.foreground,
  },

  // Payment
  payCard: {
    marginHorizontal: 12,
    marginTop: 10,
    padding: 11,
    backgroundColor: colors.primaryLight,
    borderRadius: 6,
    borderWidth: 0.5,
    borderColor: colors.primary,
  },
  payHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  radioOn: {
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 1.5,
    borderColor: colors.primary,
    backgroundColor: colors.primary,
  },
  payLabel: {
    flex: 1,
    fontSize: 12,
    fontFamily: fonts.bold,
    color: colors.primary,
  },
  payAvail: {
    fontSize: 11,
    fontFamily: fonts.semibold,
    color: colors.primary,
  },

  // Confirm button
  confirmBtn: {
    marginHorizontal: 12,
    marginTop: 12,
    paddingVertical: 12,
    borderRadius: 4,
    backgroundColor: colors.primary,
    alignItems: "center",
  },
  confirmBtnDisabled: { opacity: 0.6 },
  confirmBtnText: {
    fontSize: 13,
    fontFamily: fonts.extrabold,
    color: colors.primaryForeground,
  },
});

const BANNER_STYLES = {
  open: {
    wrap: { backgroundColor: colors.primaryLight, borderColor: colors.primaryLight2 },
    text: { color: colors.primary },
  },
  warning: {
    wrap: { backgroundColor: "#FAEEDA", borderColor: "#FAC775" },
    text: { color: "#92400E" },
  },
  closed: {
    wrap: { backgroundColor: "#FEE2E2", borderColor: "#F7C1C1" },
    text: { color: "#A32D2D" },
  },
  future: {
    wrap: { backgroundColor: colors.card, borderColor: colors.border },
    text: { color: colors.foreground },
  },
} as const;