import React, { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
} from "react-native";
import { colors, fonts } from "../lib/theme";
import {
  RazorpayCancelled,
  RazorpayFailed,
  useCreditTopUp,
} from "../hooks/useCreditTopUp";

/**
 * TopUpSheet — quick amount entry → Razorpay top-up.
 *
 * Modal slides up from the bottom. Pre-fills the shortfall amount
 * when launched from a credit-exceeded flow, otherwise blank.
 *
 *   <TopUpSheet
 *     visible={showSheet}
 *     suggestedAmount={2800}
 *     onClose={() => setShowSheet(false)}
 *     onSuccess={() => { setShowSheet(false); ... }}
 *   />
 */
interface TopUpSheetProps {
  visible: boolean;
  /** Pre-fills the amount field. Common values: shortfall, last top-up. */
  suggestedAmount?: number;
  onClose: () => void;
  /** Called after a successful top-up (verify returned ok). */
  onSuccess?: (paidAmount: number) => void;
}

const QUICK_AMOUNTS = [1000, 2500, 5000, 10000];

export default function TopUpSheet({
  visible,
  suggestedAmount,
  onClose,
  onSuccess,
}: TopUpSheetProps) {
  const [amount, setAmount] = useState<string>(
    suggestedAmount ? String(Math.ceil(suggestedAmount)) : ""
  );
  const topUp = useCreditTopUp();

  // Reset amount field when sheet opens with a new suggested amount
  React.useEffect(() => {
    if (visible) {
      setAmount(suggestedAmount ? String(Math.ceil(suggestedAmount)) : "");
    }
  }, [visible, suggestedAmount]);

  const numericAmount = parseInt(amount, 10);
  const isValid = !Number.isNaN(numericAmount) && numericAmount >= 1 && numericAmount <= 500_000;

  const handleSubmit = async () => {
    if (!isValid || topUp.isPending) return;
    try {
      const result = await topUp.mutateAsync({ amount: numericAmount });
      if (onSuccess) onSuccess(result.paidAmount);
      // Don't onClose here — let caller decide (they may show a confirmation)
    } catch (err) {
      if (err instanceof RazorpayCancelled) {
        // User cancelled the sheet — no message, just leave dialog open
        return;
      }
      if (err instanceof RazorpayFailed) {
        Alert.alert("Payment failed", err.description || "Please try again.");
        return;
      }
      Alert.alert(
        "Couldn't complete top-up",
        err instanceof Error ? err.message : "Please try again."
      );
    }
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={styles.backdrop} />
      </TouchableWithoutFeedback>

      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.kbWrap}
        pointerEvents="box-none"
      >
        <View style={styles.sheet}>
          <View style={styles.grabber} />

          <View style={styles.header}>
            <Text style={styles.title}>Top up credit</Text>
            <TouchableOpacity onPress={onClose} hitSlop={10}>
              <Text style={styles.closeX}>✕</Text>
            </TouchableOpacity>
          </View>

          <Text style={styles.subtitle}>
            Pay via UPI, card, or net banking. Amount goes against your
            outstanding balance, freeing up credit immediately.
          </Text>

          {suggestedAmount && suggestedAmount > 0 && (
            <View style={styles.hint}>
              <Text style={styles.hintText}>
                Shortfall on your current order: ₹{suggestedAmount.toFixed(2)}
              </Text>
            </View>
          )}

          <Text style={styles.label}>Amount (₹)</Text>
          <View style={styles.amountRow}>
            <Text style={styles.rupeeSign}>₹</Text>
            <TextInput
              style={styles.amountInput}
              value={amount}
              onChangeText={(t) => setAmount(t.replace(/[^0-9]/g, ""))}
              placeholder="0"
              placeholderTextColor={colors.mutedForeground}
              keyboardType="number-pad"
              maxLength={6}
              autoFocus
              editable={!topUp.isPending}
            />
          </View>

          <View style={styles.quickRow}>
            {QUICK_AMOUNTS.map((amt) => (
              <TouchableOpacity
                key={amt}
                activeOpacity={0.7}
                onPress={() => setAmount(String(amt))}
                style={styles.quickChip}
              >
                <Text style={styles.quickChipText}>₹{amt.toLocaleString("en-IN")}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <TouchableOpacity
            activeOpacity={0.85}
            disabled={!isValid || topUp.isPending}
            onPress={handleSubmit}
            style={[
              styles.payBtn,
              (!isValid || topUp.isPending) && styles.payBtnDisabled,
            ]}
          >
            {topUp.isPending ? (
              <ActivityIndicator color={colors.primaryForeground} />
            ) : (
              <Text style={styles.payBtnText}>
                Pay ₹{isValid ? numericAmount.toLocaleString("en-IN") : "0"}
              </Text>
            )}
          </TouchableOpacity>

          <Text style={styles.footnote}>
            Secured by Razorpay. Money posts to your account within seconds.
          </Text>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.45)",
  },
  kbWrap: {
    flex: 1,
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: colors.card,
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
    paddingHorizontal: 18,
    paddingTop: 8,
    paddingBottom: 28,
  },
  grabber: {
    alignSelf: "center",
    width: 38,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
    marginBottom: 14,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  title: {
    fontSize: 16,
    fontFamily: fonts.bold,
    color: colors.foreground,
  },
  closeX: {
    fontSize: 18,
    fontFamily: fonts.medium,
    color: colors.mutedForeground,
    paddingHorizontal: 4,
  },
  subtitle: {
    fontSize: 12,
    fontFamily: fonts.medium,
    color: colors.mutedForeground,
    lineHeight: 17,
    marginTop: 6,
    marginBottom: 14,
  },
  hint: {
    backgroundColor: "#FAEEDA",
    borderColor: "#FAC775",
    borderWidth: 0.5,
    borderRadius: 6,
    paddingVertical: 8,
    paddingHorizontal: 11,
    marginBottom: 14,
  },
  hintText: {
    fontSize: 11,
    fontFamily: fonts.semibold,
    color: "#92400E",
  },
  label: {
    fontSize: 11,
    fontFamily: fonts.semibold,
    color: colors.mutedForeground,
    marginBottom: 6,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  amountRow: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 0.5,
    borderColor: colors.border,
    borderRadius: 6,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 6,
    backgroundColor: colors.background,
  },
  rupeeSign: {
    fontSize: 18,
    fontFamily: fonts.bold,
    color: colors.foreground,
  },
  amountInput: {
    flex: 1,
    fontSize: 22,
    fontFamily: fonts.bold,
    color: colors.foreground,
    padding: 0,
  },
  quickRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 12,
  },
  quickChip: {
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: 0.5,
    borderColor: colors.border,
    backgroundColor: colors.background,
  },
  quickChipText: {
    fontSize: 12,
    fontFamily: fonts.semibold,
    color: colors.foreground,
  },
  payBtn: {
    marginTop: 18,
    backgroundColor: colors.primary,
    borderRadius: 4,
    paddingVertical: 14,
    alignItems: "center",
  },
  payBtnDisabled: {
    opacity: 0.5,
  },
  payBtnText: {
    fontSize: 14,
    fontFamily: fonts.extrabold,
    color: colors.primaryForeground,
  },
  footnote: {
    fontSize: 11,
    fontFamily: fonts.medium,
    color: colors.mutedForeground,
    textAlign: "center",
    marginTop: 10,
  },
});