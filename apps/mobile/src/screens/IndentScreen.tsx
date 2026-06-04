// src/screens/IndentScreen.tsx  —  FULL FILE (drop-in replacement)
//
// WHAT CHANGED & WHY
//
// 1. CONFIRM NO LONGER 404s ON A FRESH PREVIEW
//    GET /drafts/:date returns a *synthesized preview* (exists:false) when
//    no orders row exists yet. POST /confirm needs a real row. If the
//    dealer never tapped +/- (never PATCHed), confirm 404'd. handleConfirm
//    now PATCHes first when !draft.exists, materializing the row, then
//    confirms.
//
// 2. THE INDENT PAGE NOW HAS PROPER PER-STATUS STATES
//    A date's order is ONE orders row that moves through statuses. There is
//    never a separate "draft" row beside a "confirmed" one — it's the same
//    row changing status. So the page renders by status:
//      • draft / preview      → editable: +/- steppers + "Confirm" button
//      • payment_required     → locked items + "Pay for this indent"
//      • confirmed / dispatched / delivered → locked, read-only "Indent placed" card
//      • paused               → "shop paused" notice
//    Previously a confirmed order still showed editable steppers and a
//    Confirm button — tapping it re-hit /confirm and 404'd.
//
// NOTE: OrderStatus in src/lib/types.ts covers the full lifecycle:
//     "draft" | "payment_required" | "confirmed" | "dispatched"
//           | "delivered" | "cancelled"
// ("pending" has been removed — dealer confirm goes directly to "confirmed")

import React, { useMemo, useState, useEffect } from "react";
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
import DatePickerModal from "../components/DatePickerModal";
import TopUpSheet from "../components/TopUpSheet";
import QtyStepper from "../components/QtyStepper";
import { useAuthStore } from "../store/auth";
import { useNotifications } from "../hooks/useNotifications";
import { useWindowStatus } from "../hooks/useWindow";
import {
  addDaysIst,
  istTodayIso,
  relativeLabel,
  useTargetDateStore,
} from "../store/targetDate";
import {
  useDailyDraft,
  usePatchDraft,
} from "../hooks/useDailyDraft";
import { useOrderPayment } from "../hooks/useOrderPayment";
import { RazorpayCancelled } from "../lib/razorpay";
import type { DraftItem, OrderStatus } from "../lib/types";

interface IndentScreenProps {
  onOpenNotifications: () => void;
  onOpenProfile: () => void;
  onOpenManageStanding: () => void;
  /**
   * Open the indent checkout screen for the currently selected date.
   * Confirming an indent must go through checkout (pick a payment
   * mode) — it is no longer placed straight from a button tap.
   */
  onOpenCheckout: () => void;
}

export default function IndentScreen({
  onOpenNotifications,
  onOpenProfile,
  onOpenManageStanding,
  onOpenCheckout,
}: IndentScreenProps) {
  const dealer = useAuthStore((s) => s.dealer);
  const { data: notifs } = useNotifications();
  // Time-windows are route-based — fetch by routeId, not zoneId.
  const windowQuery = useWindowStatus(dealer?.routeId);

  const selectedDate = useTargetDateStore((s) => s.selectedDate);
  const setSelectedDate = useTargetDateStore((s) => s.setSelectedDate);

  const draftQuery = useDailyDraft(selectedDate);
  const patchDraft = usePatchDraft(selectedDate);

  // ── Date strip data — three fixed quick dates ──
  const quickDates = useMemo(() => {
    const t = istTodayIso();
    return [t, addDaysIst(t, 1), addDaysIst(t, 2)];
  }, []);
  const isCustomDate = !quickDates.includes(selectedDate);

  const [showCalendar, setShowCalendar] = useState(false);

  // ── Top-up / pay-now state ──
  const [showTopUp, setShowTopUp] = useState(false);
  const [shortfall, setShortfall] = useState<number | undefined>(undefined);
  const [payNowOrderId, setPayNowOrderId] = useState<string | null>(null);
  const orderPayment = useOrderPayment(payNowOrderId ?? "");

  // Fire the pay-now flow when an orderId is set
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
        if (cancelled || err instanceof RazorpayCancelled) return;
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
  }, [payNowOrderId]); // eslint-disable-line react-hooks/exhaustive-deps

  const isToday = selectedDate === istTodayIso();
  const windowState = windowQuery.data?.state ?? "closed";
  const unreadNotifications = (notifs ?? []).some((n) => !n.unread);

  const draft = draftQuery.data;
  const isPaused = draft?.paused ?? false;
  const items = draft?.items ?? [];
  const totals = draft?.totals ?? { subtotal: 0, totalGst: 0, grandTotal: 0 };

  // ── Order status → page mode ─────────────────────────────────────
  // One orders row per (dealer, delivery_date) moves through these
  // statuses. "draft" (and the synthesized preview) is the only editable
  // state. Once confirmed there is no editable draft for this date.
  const draftStatus = (draft?.status ?? "draft") as OrderStatus;
  const isPaymentRequired = draftStatus === "payment_required";
  const isPlaced =
    draftStatus === "confirmed" ||
    draftStatus === "dispatched" ||
    draftStatus === "delivered";
  const isEditable = !isPaused && !isPlaced && !isPaymentRequired;

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
    if (isPlaced) {
      return {
        kind: "success" as const,
        text:
          draftStatus === "delivered"
            ? "This indent has been delivered"
            : draftStatus === "dispatched"
            ? "Indent dispatched — on the way"
            : "Indent placed — being processed",
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
      kind:
        windowState === "warning" ? ("warning" as const) : ("open" as const),
      text: `Closes in ${min} minute${min === 1 ? "" : "s"}`,
    };
  }, [
    isPaused,
    isPlaced,
    isPaymentRequired,
    draftStatus,
    isToday,
    windowState,
    windowQuery.data?.remainingSeconds,
    draft?.pausedReason,
  ]);

  // ── Item +/- ──
  // Absolute-quantity setter — used by the editable stepper input (and +/-).
  // Lets the dealer type a quantity directly instead of tapping +.
  const setItemQty = (productId: string, qty: number) => {
    // Only a true draft / preview can be edited.
    if (!isEditable) return;
    const current = items.find((i) => i.productId === productId);
    const newQty = Math.max(0, qty);
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

  // ── Confirm ──
  // Confirming an indent must let the dealer pick a payment mode, so the
  // button no longer places the order directly — it routes to the
  // checkout screen, which handles materialising the draft, the credit
  // vs. pay-online choice, and the actual /confirm + payment calls.
  const handleConfirm = () => {
    const hasItems = items.some((i) => i.quantity > 0);
    if (!hasItems) {
      Alert.alert("Empty indent", "Add at least one item before confirming.");
      return;
    }
    onOpenCheckout();
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

      {/* ── Date strip — fixed row, no scroll ── */}
      <View style={styles.dateRow}>
        {quickDates.map((d) => {
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
                numberOfLines={1}
              >
                {relativeLabel(d)}
              </Text>
            </TouchableOpacity>
          );
        })}
        <TouchableOpacity
          activeOpacity={0.75}
          onPress={() => setShowCalendar(true)}
          style={[styles.calChip, isCustomDate && styles.dateChipActive]}
        >
          {isCustomDate ? (
            <Text style={[styles.dateChipText, styles.dateChipTextActive]}>
              {relativeLabel(selectedDate)}
            </Text>
          ) : (
            <Text style={styles.calIcon}>📅</Text>
          )}
        </TouchableOpacity>
      </View>

      <ScrollView
        style={styles.body}
        contentContainerStyle={styles.bodyContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Status banner */}
        <View style={[styles.banner, BANNER_STYLES[statusBanner.kind].wrap]}>
          <Text
            style={[styles.bannerText, BANNER_STYLES[statusBanner.kind].text]}
          >
            {statusBanner.text}
          </Text>
        </View>

        {/* ── Error state ── */}
        {draftQuery.isError && (
          <View style={styles.errorBox}>
            <Text style={styles.errorEmoji}>⚠️</Text>
            <Text style={styles.errorTitle}>Couldn't load your indent</Text>
            <Text style={styles.errorSub}>
              {draftQuery.error instanceof Error
                ? draftQuery.error.message
                : "Something went wrong."}
            </Text>
            <TouchableOpacity
              activeOpacity={0.8}
              onPress={() => draftQuery.refetch()}
              style={styles.retryBtn}
            >
              <Text style={styles.retryBtnText}>Retry</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* ── Loading ── */}
        {draftQuery.isLoading && (
          <View style={styles.loading}>
            <ActivityIndicator color={colors.primary} />
          </View>
        )}

        {/* ── Loaded ── */}
        {!draftQuery.isLoading && !draftQuery.isError && draft && (
          <>
            <View style={styles.sectionHeaderRow}>
              <Text style={styles.sectionTitle}>
                Items for {relativeLabel(selectedDate)}
              </Text>
              {isEditable && (
                <TouchableOpacity
                  activeOpacity={0.6}
                  onPress={onOpenManageStanding}
                >
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
                    // Steppers only when the order is still an editable draft.
                    disabled={!isEditable}
                    onSetQty={(qty) => setItemQty(it.productId, qty)}
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

                {/* ── EDITABLE: review → checkout (pick payment) ── */}
                {isEditable && (
                  <>
                    <View style={styles.payCard}>
                      <View style={styles.payHeader}>
                        <Text style={styles.payHint}>
                          You'll choose how to pay (credit limit or pay
                          online) on the next step.
                        </Text>
                      </View>
                    </View>

                    <TouchableOpacity
                      activeOpacity={0.8}
                      onPress={handleConfirm}
                      style={styles.confirmBtn}
                    >
                      <Text style={styles.confirmBtnText}>
                        Review &amp; confirm · {relativeLabel(selectedDate)}
                      </Text>
                    </TouchableOpacity>
                  </>
                )}

                {/* ── PLACED: read-only confirmation ── */}
                {isPlaced && <PlacedCard status={draftStatus} />}

                {/* ── PAYMENT REQUIRED: pay / top up ── */}
                {isPaymentRequired && (
                  <PaymentRequiredCard
                    busy={!!payNowOrderId}
                    onPayNow={() => {
                      if (draft.orderId) setPayNowOrderId(draft.orderId);
                    }}
                    onTopUp={() => {
                      setShortfall(undefined);
                      setShowTopUp(true);
                    }}
                  />
                )}
              </>
            )}
          </>
        )}
      </ScrollView>

      {/* Calendar modal */}
      <DatePickerModal
        visible={showCalendar}
        selectedDate={selectedDate}
        onSelect={(iso) => {
          setSelectedDate(iso);
          setShowCalendar(false);
        }}
        onClose={() => setShowCalendar(false)}
      />

      {/* Top-up sheet */}
      <TopUpSheet
        visible={showTopUp}
        suggestedAmount={shortfall}
        onClose={() => setShowTopUp(false)}
        onSuccess={(paid) => {
          setShowTopUp(false);
          Alert.alert(
            "Top-up successful",
            `₹${paid.toLocaleString(
              "en-IN"
            )} credited. Tap Confirm again to place your indent.`
          );
        }}
      />
    </View>
  );
}

// ── Sub-components ──────────────────────────────────────────────────

function DraftRow({
  item,
  isLast,
  disabled,
  onSetQty,
}: {
  item: DraftItem;
  isLast: boolean;
  disabled: boolean;
  onSetQty: (qty: number) => void;
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
      {disabled ? (
        // Read-only quantity badge — no steppers once the order is placed.
        <View style={styles.qtyBadge}>
          <Text style={styles.qtyBadgeText}>×{item.quantity}</Text>
        </View>
      ) : (
        <QtyStepper
          value={item.quantity}
          onSet={onSetQty}
          accessibilityLabel={`quantity for ${item.productName}`}
        />
      )}
    </View>
  );
}

function Row({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
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

/** Shown when the date's order is already placed (no editable draft). */
function PlacedCard({ status }: { status: OrderStatus }) {
  const sub =
    status === "delivered"
      ? "This indent was delivered."
      : status === "dispatched"
      ? "Your indent is on the way."
      : "Your indent is confirmed and being processed.";
  return (
    <View style={styles.placedCard}>
      <Text style={styles.placedIcon}>✓</Text>
      <View style={styles.placedTextCol}>
        <Text style={styles.placedTitle}>Indent placed</Text>
        <Text style={styles.placedSub}>
          {sub} Track it in the Orders tab. To change it, request a
          cancellation from Orders.
        </Text>
      </View>
    </View>
  );
}

/** Shown when the order needs payment (credit limit was exceeded). */
function PaymentRequiredCard({
  busy,
  onPayNow,
  onTopUp,
}: {
  busy: boolean;
  onPayNow: () => void;
  onTopUp: () => void;
}) {
  return (
    <View style={styles.payReqCard}>
      <Text style={styles.payReqTitle}>Payment required</Text>
      <Text style={styles.payReqSub}>
        This indent is over your available credit. Pay for it now, or top up
        your credit limit and it will auto-confirm.
      </Text>
      <TouchableOpacity
        activeOpacity={0.85}
        onPress={onPayNow}
        disabled={busy}
        style={[styles.payNowBtn, busy && styles.confirmBtnDisabled]}
      >
        {busy ? (
          <ActivityIndicator color={colors.primaryForeground} />
        ) : (
          <Text style={styles.payNowBtnText}>Pay for this indent</Text>
        )}
      </TouchableOpacity>
      <TouchableOpacity activeOpacity={0.6} onPress={onTopUp}>
        <Text style={styles.topUpLink}>Top up credit limit instead</Text>
      </TouchableOpacity>
    </View>
  );
}

// ════════════════════════════════════════════════════════════════════
// Styles
// ════════════════════════════════════════════════════════════════════

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },

  // ── Date strip — fixed row ──
  dateRow: {
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 2,
  },
  dateChip: {
    flex: 1,
    paddingVertical: 9,
    borderRadius: 8,
    borderWidth: 0.5,
    borderColor: colors.border,
    backgroundColor: colors.card,
    alignItems: "center",
    justifyContent: "center",
  },
  calChip: {
    width: 46,
    paddingVertical: 9,
    borderRadius: 8,
    borderWidth: 0.5,
    borderColor: colors.border,
    backgroundColor: colors.card,
    alignItems: "center",
    justifyContent: "center",
  },
  dateChipActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  dateChipText: {
    fontSize: 12,
    fontFamily: fonts.semibold,
    color: colors.foreground,
  },
  dateChipTextActive: { color: colors.primaryForeground },
  calIcon: { fontSize: 15 },

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

  // Loading / error
  loading: { paddingVertical: 60 },
  errorBox: {
    marginHorizontal: 12,
    marginTop: 14,
    padding: 20,
    borderRadius: 6,
    borderWidth: 0.5,
    borderColor: "#F7C1C1",
    backgroundColor: "#FEE2E2",
    alignItems: "center",
  },
  errorEmoji: { fontSize: 30 },
  errorTitle: {
    fontSize: 13,
    fontFamily: fonts.bold,
    color: "#A32D2D",
    marginTop: 8,
  },
  errorSub: {
    fontSize: 11,
    fontFamily: fonts.medium,
    color: "#A32D2D",
    marginTop: 4,
    textAlign: "center",
  },
  retryBtn: {
    marginTop: 12,
    paddingVertical: 8,
    paddingHorizontal: 22,
    borderRadius: 4,
    backgroundColor: "#A32D2D",
  },
  retryBtnText: { fontSize: 12, fontFamily: fonts.bold, color: "#fff" },

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
  // Read-only quantity badge (placed orders)
  qtyBadge: {
    minWidth: 34,
    height: 26,
    paddingHorizontal: 8,
    borderRadius: 4,
    backgroundColor: colors.background,
    alignItems: "center",
    justifyContent: "center",
  },
  qtyBadgeText: {
    fontSize: 12,
    fontFamily: fonts.extrabold,
    color: colors.foreground,
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

  // Payment (credit) card
  payCard: {
    marginHorizontal: 12,
    marginTop: 10,
    padding: 11,
    backgroundColor: colors.primaryLight,
    borderRadius: 6,
    borderWidth: 0.5,
    borderColor: colors.primary,
  },
  payHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  payHint: {
    flex: 1,
    fontSize: 11,
    fontFamily: fonts.semibold,
    color: colors.primary,
    lineHeight: 15,
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

  // Confirm
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

  // Placed (read-only) card
  placedCard: {
    flexDirection: "row",
    gap: 10,
    marginHorizontal: 12,
    marginTop: 12,
    padding: 12,
    borderRadius: 6,
    borderWidth: 0.5,
    backgroundColor: "#DCFCE7",
    borderColor: "#86EFAC",
  },
  placedIcon: {
    fontSize: 18,
    color: "#15803D",
    fontFamily: fonts.extrabold,
  },
  placedTextCol: { flex: 1 },
  placedTitle: {
    fontSize: 13,
    fontFamily: fonts.bold,
    color: "#15803D",
  },
  placedSub: {
    fontSize: 11,
    fontFamily: fonts.medium,
    color: "#166534",
    marginTop: 2,
    lineHeight: 16,
  },

  // Payment-required card
  payReqCard: {
    marginHorizontal: 12,
    marginTop: 12,
    padding: 12,
    borderRadius: 6,
    borderWidth: 0.5,
    backgroundColor: "#FAEEDA",
    borderColor: "#FAC775",
  },
  payReqTitle: {
    fontSize: 13,
    fontFamily: fonts.bold,
    color: "#92400E",
  },
  payReqSub: {
    fontSize: 11,
    fontFamily: fonts.medium,
    color: "#92400E",
    marginTop: 3,
    lineHeight: 16,
  },
  payNowBtn: {
    marginTop: 10,
    paddingVertical: 11,
    borderRadius: 4,
    backgroundColor: colors.primary,
    alignItems: "center",
  },
  payNowBtnText: {
    fontSize: 13,
    fontFamily: fonts.extrabold,
    color: colors.primaryForeground,
  },
  topUpLink: {
    fontSize: 11,
    fontFamily: fonts.semibold,
    color: "#92400E",
    textAlign: "center",
    marginTop: 9,
    textDecorationLine: "underline",
  },
});

const BANNER_STYLES = {
  open: {
    wrap: {
      backgroundColor: colors.primaryLight,
      borderColor: colors.primaryLight2,
    },
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
  success: {
    wrap: { backgroundColor: "#DCFCE7", borderColor: "#86EFAC" },
    text: { color: "#15803D" },
  },
} as const;