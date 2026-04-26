import React, { useState } from "react";
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
import { colors, fonts, shadows } from "../lib/theme";
import { useCartStore } from "../store/cart";
import { usePlaceOrder } from "../hooks/useOrders";
import { uiPaymentToBackend, type UiPaymentMethod } from "../lib/types";
import { ApiError } from "../lib/api";

/**
 * IndentCart - the full cart review screen (spec section 6.8).
 *
 * Mockup CSS reference (dealer-app.html lines 209-252, 738-787):
 *   .cart-hdr        : white, padding 42px 16px 12px, 1px border-bottom
 *   .cart-hdr-top    : back-btn (36x36 #F3F4F7 rounded-md) + h3 16px ExtraBold
 *   .cart-hdr-sub    : 10px medium ink3, ml 41px (aligns with h3 after back-btn)
 *   .deliver-chip    : brand-light bg, brand-light2 border, 999 radius, padding 5/11
 *   .cart-body       : flex 1, padding 12 12 0
 *   .savings-strip   : green-light bg, #bbf7d0 border, 11r, padding 9/12
 *   .cart-item       : white, 11r, padding 11, shadow-sm, items-center, gap 9
 *     .ci-emo        : 44x44 bg-light bg, 11r, font 24
 *     .ci-info       : flex 1, name 11/700, size 9/500, price 11/800
 *     .ci-ctrl       : 26x26 buttons in brand-light when active, 26 wide qty
 *   .bill-card       : white 11r padding 12 shadow-sm
 *     bill-row       : 6/0 padding, 1px border-bottom (none on last)
 *       gst row      : teal color
 *       total row    : 12px primary brand
 *       save row     : green
 *   .cancel-note     : amber-light bg, #fde68a border, 11r, padding 8/11
 *   .pay-footer      : white, 1px border-top, padding 12, flex-shrink 0
 *     .pay-mode      : 2px border, 11r, padding 8/5, center; selected = brand border + brand-l bg
 *     .pay-btn-main  : brand bg, 14r, padding 13, font 13/800
 */

interface IndentCartProps {
  /** Subtitle under the title, e.g. "Window closes in 1h 23m". Hidden if absent. */
  windowSubtitle?: string;
  /** Delivery location chip text, e.g. "Haveri Main Market - Zone A". */
  locationLabel: string;
  /** Optional bulk-offer savings to display in green. Hide when 0. */
  savingsAmount?: number;
  savingsLabel?: string;
  creditLimit?: number;       
  creditAvailable?: number;    // (limit - outstanding)
  walletBalance?: number;
  onBack: () => void;
  onChangeLocation: () => void;
  onOrderPlaced: (orderId: string) => void;
}

const PAYMENT_OPTIONS: ReadonlyArray<{
  id: UiPaymentMethod;
  icon: string;
  label: string;
}> = [
    { id: "wallet",  icon: "💼", label: "Wallet" },
    { id: "credit",  icon: "💳", label: "Credit" },   // <- ADD
    { id: "upi",     icon: "📱", label: "UPI" },
    { id: "card",    icon: "💳", label: "Card" },
    { id: "netbank", icon: "🏦", label: "Net Bank" },
  ];

export default function IndentCart({
  windowSubtitle,
  locationLabel,
  savingsAmount = 0,
  savingsLabel = "Bulk offer applied",
  creditLimit,       
  creditAvailable,    
  walletBalance,      
  onBack,
  onChangeLocation,
  onOrderPlaced,
}: IndentCartProps) {
  const insets = useSafeAreaInsets();

  // Cart state subscriptions - granular so we don't re-render the whole tree
  const items       = useCartStore((s) => s.getItems());
  const itemCount   = useCartStore((s) => s.getItemCount());
  const subtotal    = useCartStore((s) => s.getSubtotal());
  const totalGst    = useCartStore((s) => s.getTotalGst());
  const grandTotal  = useCartStore((s) => s.getGrandTotal());
  const addItem     = useCartStore((s) => s.addItem);
  const removeItem  = useCartStore((s) => s.removeItem);
  const clearCart   = useCartStore((s) => s.clearCart);

  const placeOrder = usePlaceOrder();
  const [selectedPay, setSelectedPay] = useState<UiPaymentMethod>("upi");

  // ── Derived totals ────────────────────────────────────────────────
  const totalAfterSavings = grandTotal - savingsAmount;
  const cgst = totalGst / 2;
  const sgst = totalGst / 2;

  const productCount = items.length;
  const isEmpty = productCount === 0;
  const submitting = placeOrder.isPending;

  // ── Submit ────────────────────────────────────────────────────────
  const handleSubmit = async () => {
    if (isEmpty || submitting) return;

    try {
      const result = await placeOrder.mutateAsync({
        items: items.map((i) => ({ productId: i.id, quantity: i.quantity })),
        paymentMode: uiPaymentToBackend(selectedPay),
      });

      clearCart();
      onOrderPlaced(result.order.id);
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.message
          : "Could not place your indent. Please try again.";
      Alert.alert("Order Failed", msg);
    }
  };

  // ══════════════════════════════════════════════════════════════════
  return (
    <View style={styles.root}>
      {/* ── Header ───────────────────────────────────────────────── */}
      <View
        style={[
          styles.header,
          { paddingTop: Math.max(insets.top + 8, 42) },
        ]}
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
          <Text style={styles.title}>Review Indent</Text>
        </View>

        <Text style={styles.subtitle}>
          {productCount} product{productCount !== 1 ? "s" : ""}
          {windowSubtitle ? ` · ${windowSubtitle}` : ""}
        </Text>

        <TouchableOpacity
          style={styles.deliverChip}
          activeOpacity={0.7}
          onPress={onChangeLocation}
        >
          <Text style={styles.deliverChipPin}>📍</Text>
          <Text style={styles.deliverChipText} numberOfLines={1}>
            {locationLabel}
          </Text>
          <Text style={styles.deliverChipChange}>Change ▾</Text>
        </TouchableOpacity>
      </View>

      {/* ── Body (scrollable) ────────────────────────────────────── */}
      <ScrollView
        style={styles.body}
        contentContainerStyle={styles.bodyContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Empty state */}
        {isEmpty && (
          <View style={styles.empty}>
            <Text style={styles.emptyEmoji}>🛒</Text>
            <Text style={styles.emptyTitle}>Your cart is empty</Text>
            <Text style={styles.emptySub}>
              Add products from the home screen to start your indent.
            </Text>
          </View>
        )}

        {/* Savings strip (only when savings > 0) */}
        {!isEmpty && savingsAmount > 0 && (
          <View style={styles.savingsStrip}>
            <Text style={styles.savingsEmoji}>🎉</Text>
            <Text style={styles.savingsText} numberOfLines={1}>
              {savingsLabel}
            </Text>
            <Text style={styles.savingsAmt}>
              –₹{savingsAmount.toFixed(2)}
            </Text>
          </View>
        )}

        {/* Item rows */}
        {items.map((item) => (
          <View key={item.id} style={styles.cartItem}>
            <View style={styles.ciEmo}>
              <Text style={styles.ciEmoText}>{item.icon ?? "📦"}</Text>
            </View>

            <View style={styles.ciInfo}>
              <Text style={styles.ciName} numberOfLines={1}>
                {item.name}
              </Text>
              <Text style={styles.ciSize} numberOfLines={1}>
                {item.unit}
              </Text>
              <Text style={styles.ciPrice}>
                ₹{Math.round(item.basePrice)} × {item.quantity} ={" "}
                <Text style={styles.ciPriceStrong}>
                  ₹{item.lineSubtotal.toFixed(2)}
                </Text>
              </Text>
            </View>

            <View style={styles.ciCtrl}>
              <TouchableOpacity
                style={[styles.ciBtn, styles.ciBtnActive]}
                activeOpacity={0.6}
                onPress={() => removeItem(item.id)}
                accessibilityLabel={`Decrease ${item.name}`}
              >
                <Text style={styles.ciBtnIconActive}>−</Text>
              </TouchableOpacity>
              <Text style={styles.ciQty}>{item.quantity}</Text>
              <TouchableOpacity
                style={[styles.ciBtn, styles.ciBtnActive]}
                activeOpacity={0.6}
                onPress={() => addItem(item)}
                accessibilityLabel={`Increase ${item.name}`}
              >
                <Text style={styles.ciBtnIconActive}>+</Text>
              </TouchableOpacity>
            </View>
          </View>
        ))}

        {/* Bill summary */}
        {!isEmpty && (
          <View style={styles.billCard}>
            <Text style={styles.billTitle}>📄 Bill Summary</Text>

            <BillRow
              left={`Item total (${itemCount} pcs)`}
              right={`₹ ${subtotal.toFixed(2)}`}
            />

            {savingsAmount > 0 && (
              <BillRow
                variant="save"
                left={`🎉 ${savingsLabel}`}
                right={`–₹ ${savingsAmount.toFixed(2)}`}
              />
            )}

            <BillRow
              variant="gst"
              left="CGST @ 2.5%"
              right={`₹ ${cgst.toFixed(2)}`}
            />
            <BillRow
              variant="gst"
              left="SGST @ 2.5%"
              right={`₹ ${sgst.toFixed(2)}`}
            />

            <BillRow
              variant="total"
              left="Total Payable"
              right={`₹ ${totalAfterSavings.toFixed(2)}`}
            />
          </View>
        )}

        {/* Cancel policy strip */}
        {!isEmpty && (
          <View style={styles.cancelNote}>
            <Text style={styles.cancelEmoji}>⏱️</Text>
            <Text style={styles.cancelText}>
              You can cancel this indent within{" "}
              <Text style={styles.cancelStrong}>15 minutes</Text> of payment.
              After that, cancellation requires admin approval.
            </Text>
          </View>
        )}
      </ScrollView>

      {/* ── Pay footer ───────────────────────────────────────────── */}
      {!isEmpty && (
        <View
          style={[
            styles.payFooter,
            { paddingBottom: Math.max(insets.bottom, 12) },
          ]}
        >
          <View style={styles.payModes}>
          {PAYMENT_OPTIONS.map((opt) => {
            const isSelected = selectedPay === opt.id;
            const sub =
                opt.id === "wallet" ? `₹${walletBalance?.toFixed(0) ?? "0"}` :
                opt.id === "credit" && creditAvailable !== undefined
                ? `₹${creditAvailable.toFixed(0)} avail`
                : undefined;

            // Disable credit if no headroom
            const disabled =
                (opt.id === "credit" && (creditAvailable ?? 0) < grandTotal) ||
                (opt.id === "wallet" && (walletBalance ?? 0) < grandTotal);

            return (
                <TouchableOpacity
                key={opt.id}
                onPress={() => !disabled && setSelectedPay(opt.id)}
                disabled={disabled}
                style={[
                    styles.payMode,
                    isSelected && styles.payModeSelected,
                    disabled && { opacity: 0.4 },
                ]}
                >
                <Text style={styles.payIcon}>{opt.icon}</Text>
                <Text style={styles.payLabel}>{opt.label}</Text>
                {sub && <Text style={styles.paySub}>{sub}</Text>}
                </TouchableOpacity>
            );
            })}
          </View>

          <TouchableOpacity
            style={[
              styles.payBtn,
              submitting && styles.payBtnDisabled,
            ]}
            activeOpacity={0.85}
            onPress={handleSubmit}
            disabled={submitting}
            accessibilityRole="button"
          >
            {submitting ? (
              <ActivityIndicator color={colors.primaryForeground} />
            ) : (
              <Text style={styles.payBtnText}>
                🔒 Pay ₹ {totalAfterSavings.toFixed(2)} securely
              </Text>
            )}
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

// ════════════════════════════════════════════════════════════════════════
// BillRow - extracted because the variants would bloat the parent
// ════════════════════════════════════════════════════════════════════════

interface BillRowProps {
  left: string;
  right: string;
  variant?: "default" | "save" | "gst" | "total";
}

function BillRow({ left, right, variant = "default" }: BillRowProps) {
  const styles = BILL_ROW_STYLES;
  return (
    <View style={styles.row}>
      <Text
        style={[
          styles.left,
          variant === "save" && styles.leftSave,
          variant === "gst" && styles.leftGst,
          variant === "total" && styles.leftTotal,
        ]}
      >
        {left}
      </Text>
      <Text
        style={[
          styles.right,
          variant === "save" && styles.rightSave,
          variant === "gst" && styles.rightGst,
          variant === "total" && styles.rightTotal,
        ]}
      >
        {right}
      </Text>
    </View>
  );
}

// ════════════════════════════════════════════════════════════════════════
// Styles
// ════════════════════════════════════════════════════════════════════════

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
  },

  // Header ----------------------------------------------------------
  header: {
    backgroundColor: colors.card,
    paddingHorizontal: 16,
    paddingBottom: 12,                     // mockup
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerTop: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
  },
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
    fontSize: 16,                          // mockup
    fontFamily: fonts.extrabold,
    color: colors.foreground,
  },
  subtitle: {
    fontSize: 10,                          // mockup
    fontFamily: fonts.medium,
    color: colors.mutedForeground,
    marginTop: 3,
    marginLeft: 41,                        // mockup: aligns under title
  },
  deliverChip: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: colors.primaryLight,
    borderWidth: 1.5,
    borderColor: colors.primaryLight2,
    borderRadius: 999,
    paddingVertical: 5,                    // mockup
    paddingHorizontal: 11,
    marginTop: 9,
    marginLeft: 41,                        // align with subtitle
  },
  deliverChipPin: {
    fontSize: 10,
  },
  deliverChipText: {
    fontSize: 10,                          // mockup
    fontFamily: fonts.bold,
    color: colors.primary,
    maxWidth: 200,
  },
  deliverChipChange: {
    fontSize: 9,
    fontFamily: fonts.bold,
    color: colors.primary,
    opacity: 0.6,
    marginLeft: 3,
  },

  // Body ------------------------------------------------------------
  body: {
    flex: 1,
  },
  bodyContent: {
    paddingHorizontal: 12,                 // mockup
    paddingTop: 12,
    paddingBottom: 12,
  },

  // Empty state -----------------------------------------------------
  empty: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 64,
  },
  emptyEmoji: {
    fontSize: 56,
    marginBottom: 12,
  },
  emptyTitle: {
    fontSize: 14,
    fontFamily: fonts.extrabold,
    color: colors.foreground,
  },
  emptySub: {
    fontSize: 11,
    fontFamily: fonts.medium,
    color: colors.mutedForeground,
    marginTop: 6,
    textAlign: "center",
    paddingHorizontal: 24,
    lineHeight: 16,
  },

  // Savings strip ---------------------------------------------------
  savingsStrip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    backgroundColor: colors.successLight,
    borderWidth: 1.5,
    borderColor: colors.successBorder,
    borderRadius: 11,
    paddingVertical: 9,
    paddingHorizontal: 12,
    marginBottom: 9,
  },
  savingsEmoji: {
    fontSize: 14,
  },
  savingsText: {
    flex: 1,
    fontSize: 10,
    fontFamily: fonts.bold,
    color: colors.success,
  },
  savingsAmt: {
    fontSize: 12,
    fontFamily: fonts.headingBlack,
    color: colors.success,
  },

  // Cart item -------------------------------------------------------
  cartItem: {
    backgroundColor: colors.card,
    borderRadius: 11,
    padding: 11,
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    marginBottom: 8,
    ...shadows.sm,
  },
  ciEmo: {
    width: 44,                              // mockup: 44x44
    height: 44,
    backgroundColor: colors.background,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  ciEmoText: {
    fontSize: 24,                           // mockup
  },
  ciInfo: {
    flex: 1,
  },
  ciName: {
    fontSize: 11,                           // mockup
    fontFamily: fonts.bold,
    color: colors.foreground,
  },
  ciSize: {
    fontSize: 9,
    fontFamily: fonts.medium,
    color: colors.mutedForeground,
    marginTop: 1,
  },
  ciPrice: {
    fontSize: 11,
    fontFamily: fonts.extrabold,
    color: colors.ink2,
    marginTop: 3,
  },
  ciPriceStrong: {
    fontFamily: fonts.headingExtra,
    color: colors.ink2,
  },
  ciCtrl: {
    flexDirection: "row",
    alignItems: "center",
  },
  ciBtn: {
    width: 26,                              // mockup: 26x26
    height: 26,
    borderRadius: 7,
    borderWidth: 1.5,
    backgroundColor: colors.background,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  ciBtnActive: {
    borderColor: colors.primary,
    backgroundColor: colors.primaryLight,
  },
  ciBtnIconActive: {
    fontSize: 15,
    fontFamily: fonts.headingBlack,
    color: colors.primary,
    lineHeight: 17,
  },
  ciQty: {
    width: 26,
    textAlign: "center",
    fontSize: 13,
    fontFamily: fonts.extrabold,
    color: colors.foreground,
  },

  // Cancel note -----------------------------------------------------
  cancelNote: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    backgroundColor: colors.warningLight,
    borderWidth: 1.5,
    borderColor: colors.warningBorder,
    borderRadius: 11,
    paddingVertical: 8,
    paddingHorizontal: 11,
    marginBottom: 10,
  },
  cancelEmoji: {
    fontSize: 14,
  },
  cancelText: {
    flex: 1,
    fontSize: 9,
    fontFamily: fonts.semibold,
    color: colors.warning,
    lineHeight: 12.6,                        // 9 * 1.4
  },
  cancelStrong: {
    fontFamily: fonts.extrabold,
  },

  // Bill card -------------------------------------------------------
  billCard: {
    backgroundColor: colors.card,
    borderRadius: 11,
    padding: 12,
    marginBottom: 9,
    ...shadows.sm,
  },
  billTitle: {
    fontSize: 11,
    fontFamily: fonts.extrabold,
    color: colors.ink2,
    marginBottom: 9,
  },

  // Pay footer ------------------------------------------------------
  payFooter: {
    backgroundColor: colors.card,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingHorizontal: 12,
    paddingTop: 12,
  },
  payModes: {
    flexDirection: "row",
    gap: 7,
    marginBottom: 10,
  },
  payMode: {
    flex: 1,
    borderWidth: 2,
    borderColor: colors.border,
    borderRadius: 11,
    paddingVertical: 8,
    paddingHorizontal: 5,
    alignItems: "center",
    backgroundColor: colors.card,
  },
  payModeSelected: {
    borderColor: colors.primary,
    backgroundColor: colors.primaryLight,
  },
  pmIcon: {
    fontSize: 16,
    marginBottom: 2,
  },
  pmLabel: {
    fontSize: 8,
    fontFamily: fonts.bold,
    color: colors.mutedForeground,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  pmLabelSelected: {
    color: colors.primary,
  },
  payBtn: {
    backgroundColor: colors.primary,
    borderRadius: 14,
    paddingVertical: 13,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 7,
    minHeight: 48,
  },
  payBtnDisabled: {
    backgroundColor: colors.ink4,
  },
  payBtnText: {
    fontSize: 13,
    fontFamily: fonts.extrabold,
    color: colors.primaryForeground,
  },
  
  payIcon: {
    fontSize: 16,
    marginBottom: 2,
  },

  payLabel: {
    fontSize: 8,
    fontFamily: fonts.bold,
    color: colors.mutedForeground,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  paySub: {
    fontSize: 8,
    fontFamily: fonts.bold,
    color: colors.mutedForeground,
    marginTop: 2,
  },
});

// ── BillRow styles ─────────────────────────────────────────────────────
const BILL_ROW_STYLES = StyleSheet.create({
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  left: {
    fontSize: 11,
    fontFamily: fonts.medium,
    color: colors.ink2,
  },
  right: {
    fontSize: 11,
    fontFamily: fonts.bold,
    color: colors.ink2,
  },

  leftSave: { color: colors.success, fontFamily: fonts.semibold },
  rightSave: { color: colors.success, fontFamily: fonts.bold },

  leftGst:  { color: colors.info, fontFamily: fonts.semibold },
  rightGst: { color: colors.info },

  leftTotal: {
    fontSize: 12,
    fontFamily: fonts.extrabold,
    color: colors.foreground,
  },
  rightTotal: {
    fontSize: 12,
    fontFamily: fonts.headingBlack,
    color: colors.primary,
  },
});