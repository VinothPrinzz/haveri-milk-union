import React, { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { colors, fonts } from "../lib/theme";
import { useAuthStore } from "../store/auth";
import TopUpSheet from "./TopUpSheet";

/**
 * ProfileFinanceCard — prepaid available-balance summary + top-up CTA.
 *
 * Reads `creditAvailable` / `creditOutstanding` from the auth store's
 * dealer record (refreshed via the `/dealer/profile` endpoint). There is
 * no credit limit — customers spend only what they've topped up.
 *
 * Drop into ProfileScreen at the top, right under the profile header.
 */

export default function ProfileFinanceCard() {
  const dealer = useAuthStore((s) => s.dealer);
  const [showTopUp, setShowTopUp] = useState(false);

  if (!dealer) return null;

  const outstanding   = dealer.creditOutstanding ?? 0;
  const ledgerBalance = dealer.ledgerBalance ?? 0;        // + prepaid / − owed
  // Prepaid model: available balance is whatever the customer has topped up
  // (opening + top-ups − purchases), floored at 0. No credit limit.
  const available     = dealer.creditAvailable ?? Math.max(0, ledgerBalance);
  const isEmpty       = available <= 0;

  const variant: "ok" | "critical" = isEmpty ? "critical" : "ok";
  const stripe = STRIPE_STYLES[variant];

  return (
    <>
      <View style={[styles.card, { borderColor: stripe.border }]}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle}>Available balance</Text>
        </View>

        <Text style={styles.bigAmount}>
          ₹{available.toLocaleString("en-IN", { minimumFractionDigits: 2 })}
          <Text style={styles.bigAmountSuffix}> available</Text>
        </Text>

        {outstanding > 0 && (
          <View style={[styles.row, { marginTop: 10 }]}>
            <Text style={styles.rowLabel}>Outstanding</Text>
            <Text style={styles.rowValue}>
              ₹{outstanding.toLocaleString("en-IN", { minimumFractionDigits: 2 })}
            </Text>
          </View>
        )}

        <View style={styles.ctaRow}>
          <TouchableOpacity
            activeOpacity={0.85}
            onPress={() => setShowTopUp(true)}
            style={styles.topUpBtn}
          >
            <Text style={styles.topUpBtnText}>Top up balance</Text>
          </TouchableOpacity>
        </View>

        {isEmpty && (
          <View style={[styles.alertStripe, { backgroundColor: stripe.bg }]}>
            <Text style={[styles.alertText, { color: stripe.label }]}>
              Balance empty. Top up to place new orders.
            </Text>
          </View>
        )}
      </View>

      <TopUpSheet
        visible={showTopUp}
        onClose={() => setShowTopUp(false)}
        onSuccess={(paid) => {
          setShowTopUp(false);
          Alert.alert(
            "Top-up successful",
            `₹${paid.toLocaleString("en-IN")} credited. Your available balance will refresh shortly.`
          );
        }}
      />
    </>
  );
}

// ── Variant styling ─────────────────────────────────────────────────
const STRIPE_STYLES: Record<
  "ok" | "warning" | "critical",
  { bar: string; border: string; bg: string; label: string }
> = {
  ok: {
    bar: colors.primary,
    border: colors.border,
    bg: colors.primaryLight,
    label: colors.primary,
  },
  warning: {
    bar: "#D97706",
    border: "#FAC775",
    bg: "#FAEEDA",
    label: "#92400E",
  },
  critical: {
    bar: "#A32D2D",
    border: "#F7C1C1",
    bg: "#FEE2E2",
    label: "#A32D2D",
  },
};

const styles = StyleSheet.create({
  card: {
    marginHorizontal: 12,
    backgroundColor: colors.card,
    borderRadius: 8,
    borderWidth: 0.5,
    padding: 14,
  },
  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
  },
  cardTitle: {
    fontSize: 12,
    fontFamily: fonts.bold,
    color: colors.mutedForeground,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  pct: {
    fontSize: 11,
    fontFamily: fonts.extrabold,
  },
  bigAmount: {
    fontSize: 26,
    fontFamily: fonts.extrabold,
    color: colors.foreground,
    marginTop: 6,
  },
  bigAmountSuffix: {
    fontSize: 12,
    fontFamily: fonts.medium,
    color: colors.mutedForeground,
  },
  barWrap: {
    height: 5,
    backgroundColor: colors.background,
    borderRadius: 999,
    overflow: "hidden",
    marginTop: 10,
    marginBottom: 12,
  },
  barFill: {
    height: "100%",
    borderRadius: 999,
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 3,
  },
  rowLabel: {
    fontSize: 11,
    fontFamily: fonts.medium,
    color: colors.mutedForeground,
  },
  rowValue: {
    fontSize: 12,
    fontFamily: fonts.semibold,
    color: colors.foreground,
  },
  ctaRow: { marginTop: 12 },
  topUpBtn: {
    backgroundColor: colors.primary,
    borderRadius: 4,
    paddingVertical: 11,
    alignItems: "center",
  },
  topUpBtnText: {
    fontSize: 13,
    fontFamily: fonts.extrabold,
    color: colors.primaryForeground,
  },
  alertStripe: {
    marginTop: 12,
    padding: 9,
    borderRadius: 4,
  },
  alertText: {
    fontSize: 11,
    fontFamily: fonts.semibold,
    lineHeight: 15,
  },
});