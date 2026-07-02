// src/screens/IndentCheckoutScreen.tsx  —  NEW FILE
//
// WHY THIS SCREEN EXISTS
//
// Confirming an indent for a date used to place the order straight from
// the "Confirm" button on IndentScreen, hard-coded to `paymentMode:
// "credit"`. The dealer never got to choose how to pay. This screen is
// the indent equivalent of the cart's review/checkout step:
//
//   IndentScreen  ──"Review & confirm"──▶  IndentCheckoutScreen
//
// It reads the SAME draft (useDailyDraft for the globally-selected date),
// shows a read-only review of the items + bill, and lets the dealer pick:
//
//   • Use available balance → POST /drafts/:date/confirm { paymentMode:"credit" }
//   • Pay online         → materialise the draft, then Razorpay pay-now
//                          (UPI / card / netbanking inside the sheet)
//
// On success it routes back to the Indent tab, which now shows the
// read-only "Indent placed" view for that date.
//
// NOTE ON MATERIALISING: a synthesized preview (exists:false) has no
// orders row. /confirm and /pay-now both need one, so we PATCH the
// preview's items first to create it — exactly what the old handleConfirm
// did, just moved here.

import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors, fonts } from "../lib/theme";
import { useAuthStore } from "../store/auth";
import {
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
import { useOrderPayment } from "../hooks/useOrderPayment";
import { RazorpayCancelled } from "../lib/razorpay";
import type { DraftItem, OrderStatus } from "../lib/types";

interface IndentCheckoutScreenProps {
  /** Go back to the Indent tab without placing anything. */
  onBack: () => void;
  /** Indent successfully confirmed / paid — return to the Indent tab. */
  onConfirmed: () => void;
}

type PayMode = "credit" | "online";

export default function IndentCheckoutScreen({
  onBack,
  onConfirmed,
}: IndentCheckoutScreenProps) {
  const insets = useSafeAreaInsets();
  const dealer = useAuthStore((s) => s.dealer);

  // The date being checked out is the globally-selected indent date.
  const selectedDate = useTargetDateStore((s) => s.selectedDate);
  // Future dates are never paid in advance — they auto-place at their own
  // window close, drawn from available balance. IndentScreen no longer opens
  // checkout for a future date; this guard keeps the payment step from ever
  // rendering for one even if some other path reaches here.
  const isFuture = !!selectedDate && selectedDate > istTodayIso();

  const draftQuery = useDailyDraft(selectedDate);
  const patchDraft = usePatchDraft(selectedDate);
  const confirmDraft = useConfirmDraft(selectedDate);

  const draft = draftQuery.data;
  const items = useMemo(
    () => (draft?.items ?? []).filter((i) => i.quantity > 0),
    [draft]
  );
  const totals = draft?.totals ?? {
    subtotal: 0,
    totalGst: 0,
    grandTotal: 0,
  };
  const draftStatus = (draft?.status ?? "draft") as OrderStatus;
  const isPlaced =
    draftStatus === "confirmed" ||
    draftStatus === "dispatched" ||
    draftStatus === "delivered";

  // A dealer with no delivery route can't place orders (the server rejects
  // every order-creating call with 403). Surface that up front instead of
  // letting them tap "Confirm" into a dead-end error.
  const hasRoute = !!dealer?.routeId;

  // ── Available balance (prepaid — no credit limit) ──
  // Whatever the customer has topped up, floored at 0. Comes straight from
  // the API's credit_available (opening + top-ups − purchases).
  const creditAvailable = Math.max(0, dealer?.creditAvailable ?? 0);
  const creditOk = creditAvailable >= totals.grandTotal;

  // ── Payment selection ──
  // `mode === null` means "not chosen yet" → fall back to a sensible
  // default once the draft has loaded (credit if there's headroom).
  const [mode, setMode] = useState<PayMode | null>(null);
  const effectiveMode: PayMode = mode ?? (creditOk ? "credit" : "online");

  // ── Busy / pay-online plumbing ──
  const [busy, setBusy] = useState(false);
  const [payOrderId, setPayOrderId] = useState<string | null>(null);
  const orderPayment = useOrderPayment(payOrderId ?? "");

  // Materialise the draft into a real orders row (if needed) and return
  // its orderId. /confirm and /pay-now both require a persisted row.
  const ensureOrderId = async (): Promise<string> => {
    if (draft?.exists && draft.orderId) return draft.orderId;
    const lineItems = items.map((i) => ({
      productId: i.productId,
      quantity: i.quantity,
    }));
    if (lineItems.length === 0) {
      throw new Error("Add at least one item before confirming.");
    }
    const patched = await patchDraft.mutateAsync(lineItems);
    return patched.orderId;
  };

  // ── Credit path ──
  const confirmWithCredit = async () => {
    setBusy(true);
    try {
      await ensureOrderId();
      await confirmDraft.mutateAsync({ paymentMode: "credit" });
      setBusy(false);
      Alert.alert(
        "Indent confirmed",
        `Your indent for ${relativeLabel(selectedDate)} is placed on credit.`,
        [{ text: "Done", onPress: onConfirmed }]
      );
    } catch (err) {
      setBusy(false);
      if (isCreditExceededError(err)) {
        Alert.alert(
          "Insufficient balance",
          `This indent is over your available balance by ₹${err.body.credit.shortfall.toFixed(
            2
          )}. Pay online to place it instead.`,
          [{ text: "Pay online", onPress: () => setMode("online") }]
        );
        return;
      }
      Alert.alert(
        "Could not confirm",
        err instanceof Error ? err.message : "Please try again."
      );
    }
  };

  // ── Pay-online path ── (kick off — the effect below runs the SDK)
  const payOnline = async () => {
    setBusy(true);
    try {
      const orderId = await ensureOrderId();
      setPayOrderId(orderId);
    } catch (err) {
      setBusy(false);
      Alert.alert(
        "Could not start payment",
        err instanceof Error ? err.message : "Please try again."
      );
    }
  };

  // Razorpay runs once an orderId is set. Mirrors IndentScreen's pay-now.
  useEffect(() => {
    if (!payOrderId) return;
    let cancelled = false;
    (async () => {
      try {
        await orderPayment.mutateAsync();
        if (cancelled) return;
        setBusy(false);
        setPayOrderId(null);
        Alert.alert(
          "Payment successful",
          `Your indent for ${relativeLabel(selectedDate)} is confirmed.`,
          [{ text: "Done", onPress: onConfirmed }]
        );
      } catch (err) {
        if (cancelled) return;
        setBusy(false);
        setPayOrderId(null);
        if (err instanceof RazorpayCancelled) return; // user closed sheet
        Alert.alert(
          "Payment failed",
          err instanceof Error ? err.message : "Please try again."
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [payOrderId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handlePay = () => {
    if (busy) return;
    if (items.length === 0) {
      Alert.alert("Empty indent", "Add at least one item before confirming.");
      return;
    }
    if (effectiveMode === "credit") confirmWithCredit();
    else payOnline();
  };

  // ════════════════════════════════════════════════════════════════
  return (
    <View style={styles.root}>
      {/* Header */}
      <View
        style={[styles.header, { paddingTop: Math.max(insets.top + 8, 42) }]}
      >
        <View style={styles.headerTop}>
          <TouchableOpacity
            onPress={onBack}
            style={styles.backBtn}
            activeOpacity={0.7}
            accessibilityLabel="Go back"
          >
            <Text style={styles.backIcon}>←</Text>
          </TouchableOpacity>
          <Text style={styles.title}>Confirm indent</Text>
        </View>
        <Text style={styles.subtitle}>
          Delivery {relativeLabel(selectedDate)} · choose how to pay
        </Text>
      </View>

      {/* Body */}
      <ScrollView
        style={styles.body}
        contentContainerStyle={styles.bodyContent}
        showsVerticalScrollIndicator={false}
      >
        {draftQuery.isLoading && (
          <View style={styles.loading}>
            <ActivityIndicator color={colors.primary} />
          </View>
        )}

        {draftQuery.isError && (
          <View style={styles.notice}>
            <Text style={styles.noticeTitle}>Couldn't load your indent</Text>
            <Text style={styles.noticeSub}>
              {draftQuery.error instanceof Error
                ? draftQuery.error.message
                : "Something went wrong."}
            </Text>
          </View>
        )}

        {!draftQuery.isLoading && !draftQuery.isError && (
          <>
            {!hasRoute ? (
              <View style={styles.notice}>
                <Text style={styles.noticeTitle}>No delivery route assigned</Text>
                <Text style={styles.noticeSub}>
                  Your account isn't assigned to a delivery route yet, so
                  orders can't be placed. Please contact the dairy office to
                  get a route assigned.
                </Text>
              </View>
            ) : isPlaced ? (
              <View style={styles.notice}>
                <Text style={styles.noticeTitle}>Indent already placed</Text>
                <Text style={styles.noticeSub}>
                  This date's indent is already confirmed. You can track it
                  in the Orders tab.
                </Text>
              </View>
            ) : isFuture ? (
              <View style={styles.notice}>
                <Text style={styles.noticeTitle}>Scheduled — no payment now</Text>
                <Text style={styles.noticeSub}>
                  Indents for a future date are placed automatically at that
                  date's window close, using your available balance. Edit the
                  items from the Indent tab anytime before then.
                </Text>
              </View>
            ) : items.length === 0 ? (
              <View style={styles.notice}>
                <Text style={styles.noticeTitle}>Nothing to confirm</Text>
                <Text style={styles.noticeSub}>
                  Add at least one item from the Indent tab first.
                </Text>
              </View>
            ) : (
              <>
                {/* Items review (read-only) */}
                <Text style={styles.sectionTitle}>
                  {items.length} item{items.length === 1 ? "" : "s"}
                </Text>
                <View style={styles.card}>
                  {items.map((it, idx) => (
                    <ItemRow
                      key={it.productId}
                      item={it}
                      isLast={idx === items.length - 1}
                    />
                  ))}
                </View>

                {/* Bill */}
                <View style={styles.card}>
                  <SummaryRow
                    label="Subtotal"
                    value={`₹${totals.subtotal.toFixed(2)}`}
                  />
                  <SummaryRow
                    label="GST"
                    value={`₹${totals.totalGst.toFixed(2)}`}
                  />
                  <View style={styles.divider} />
                  <SummaryRow
                    label="Total payable"
                    value={`₹${totals.grandTotal.toFixed(2)}`}
                    emphasis
                  />
                </View>

                {/* Payment mode */}
                <Text style={styles.sectionTitle}>Payment method</Text>

                <PayOption
                  selected={effectiveMode === "credit"}
                  disabled={!creditOk}
                  icon="🧾"
                  title="Use available balance"
                  subtitle={
                    creditOk
                      ? `₹${creditAvailable.toFixed(0)} available`
                      : `Short by ₹${(
                          totals.grandTotal - creditAvailable
                        ).toFixed(0)} — not enough balance`
                  }
                  onPress={() => setMode("credit")}
                />
                <PayOption
                  selected={effectiveMode === "online"}
                  icon="📱"
                  title="Pay online"
                  subtitle="UPI · Card · Net banking"
                  onPress={() => setMode("online")}
                />

                <Text style={styles.policyNote}>
                  You can cancel within 15 minutes of confirming. After that,
                  cancellation needs admin approval.
                </Text>
              </>
            )}
          </>
        )}
      </ScrollView>

      {/* Pay footer */}
      {!draftQuery.isLoading &&
        !draftQuery.isError &&
        hasRoute &&
        !isPlaced &&
        !isFuture &&
        items.length > 0 && (
          <View
            style={[
              styles.footer,
              { paddingBottom: Math.max(insets.bottom, 12) },
            ]}
          >
            <TouchableOpacity
              activeOpacity={0.85}
              onPress={handlePay}
              disabled={busy}
              style={[styles.payBtn, busy && styles.payBtnDisabled]}
            >
              {busy ? (
                <ActivityIndicator color={colors.primaryForeground} />
              ) : (
                <Text style={styles.payBtnText}>
                  {effectiveMode === "credit"
                    ? `Confirm on credit · ₹${totals.grandTotal.toFixed(2)}`
                    : `🔒 Pay ₹${totals.grandTotal.toFixed(2)} online`}
                </Text>
              )}
            </TouchableOpacity>
          </View>
        )}
    </View>
  );
}

// ── Sub-components ──────────────────────────────────────────────────

function ItemRow({ item, isLast }: { item: DraftItem; isLast: boolean }) {
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
      <View style={styles.itemRight}>
        <Text style={styles.itemQty}>×{item.quantity}</Text>
        <Text style={styles.itemLine}>₹{item.lineTotal.toFixed(2)}</Text>
      </View>
    </View>
  );
}

function SummaryRow({
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

function PayOption({
  selected,
  disabled,
  icon,
  title,
  subtitle,
  onPress,
}: {
  selected: boolean;
  disabled?: boolean;
  icon: string;
  title: string;
  subtitle: string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      activeOpacity={0.8}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.payOption,
        selected && styles.payOptionSelected,
        disabled && styles.payOptionDisabled,
      ]}
    >
      <Text style={styles.payOptionIcon}>{icon}</Text>
      <View style={styles.payOptionBody}>
        <Text style={styles.payOptionTitle}>{title}</Text>
        <Text style={styles.payOptionSub}>{subtitle}</Text>
      </View>
      <View style={[styles.radio, selected && styles.radioOn]}>
        {selected && <View style={styles.radioDot} />}
      </View>
    </TouchableOpacity>
  );
}

// ── Styles ──────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },

  // Header
  header: {
    backgroundColor: colors.card,
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerTop: { flexDirection: "row", alignItems: "center", gap: 9 },
  backBtn: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: colors.muted,
    alignItems: "center",
    justifyContent: "center",
  },
  backIcon: {
    fontSize: 18,
    fontFamily: fonts.bold,
    color: colors.foreground,
    lineHeight: 20,
  },
  title: {
    fontSize: 16,
    fontFamily: fonts.extrabold,
    color: colors.foreground,
  },
  subtitle: {
    fontSize: 10,
    fontFamily: fonts.medium,
    color: colors.mutedForeground,
    marginTop: 3,
    marginLeft: 41,
  },

  // Body
  body: { flex: 1 },
  bodyContent: { padding: 12, paddingBottom: 24 },
  loading: { paddingVertical: 60 },

  notice: {
    marginTop: 14,
    padding: 18,
    borderRadius: 8,
    borderWidth: 0.5,
    borderColor: colors.border,
    backgroundColor: colors.card,
    alignItems: "center",
  },
  noticeTitle: {
    fontSize: 13,
    fontFamily: fonts.bold,
    color: colors.foreground,
  },
  noticeSub: {
    fontSize: 11,
    fontFamily: fonts.medium,
    color: colors.mutedForeground,
    marginTop: 4,
    textAlign: "center",
    lineHeight: 16,
  },

  sectionTitle: {
    fontSize: 12,
    fontFamily: fonts.bold,
    color: colors.foreground,
    marginTop: 6,
    marginBottom: 6,
  },

  // Cards
  card: {
    backgroundColor: colors.card,
    borderRadius: 8,
    borderWidth: 0.5,
    borderColor: colors.border,
    overflow: "hidden",
    marginBottom: 10,
  },

  // Item row
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
  itemRight: { alignItems: "flex-end" },
  itemQty: {
    fontSize: 11,
    fontFamily: fonts.bold,
    color: colors.mutedForeground,
  },
  itemLine: {
    fontSize: 12,
    fontFamily: fonts.extrabold,
    color: colors.foreground,
    marginTop: 1,
  },

  // Summary
  summaryRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 6,
    paddingHorizontal: 12,
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
  divider: { height: 0.5, backgroundColor: colors.border, marginVertical: 2 },
  summaryTotalLabel: {
    fontSize: 13,
    fontFamily: fonts.bold,
    color: colors.foreground,
  },
  summaryTotalValue: {
    fontSize: 14,
    fontFamily: fonts.extrabold,
    color: colors.primary,
  },

  // Payment options
  payOption: {
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    backgroundColor: colors.card,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: colors.border,
    paddingVertical: 11,
    paddingHorizontal: 12,
    marginBottom: 8,
  },
  payOptionSelected: {
    borderColor: colors.primary,
    backgroundColor: colors.primaryLight,
  },
  payOptionDisabled: { opacity: 0.45 },
  payOptionIcon: { fontSize: 20 },
  payOptionBody: { flex: 1 },
  payOptionTitle: {
    fontSize: 12,
    fontFamily: fonts.bold,
    color: colors.foreground,
  },
  payOptionSub: {
    fontSize: 10,
    fontFamily: fonts.medium,
    color: colors.mutedForeground,
    marginTop: 1,
  },
  radio: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1.5,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  radioOn: { borderColor: colors.primary },
  radioDot: {
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: colors.primary,
  },

  policyNote: {
    fontSize: 10,
    fontFamily: fonts.medium,
    color: colors.mutedForeground,
    lineHeight: 14,
    marginTop: 2,
    marginBottom: 4,
  },

  // Footer
  footer: {
    backgroundColor: colors.card,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingHorizontal: 12,
    paddingTop: 12,
  },
  payBtn: {
    backgroundColor: colors.primary,
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 48,
  },
  payBtnDisabled: { opacity: 0.6 },
  payBtnText: {
    fontSize: 13,
    fontFamily: fonts.extrabold,
    color: colors.primaryForeground,
  },
});