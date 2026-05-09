import React, { useEffect, useMemo, useRef } from "react";
import {
  Alert,
  Animated,
  Easing,
  Linking,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  colors,
  cssAngleToPoints,
  fonts,
} from "../lib/theme";
import { useAuthStore } from "../store/auth";
import { useMyOrders } from "../hooks/useOrders";
import { useMyInvoices, useInvoiceByOrder } from "../hooks/useInvoices";
import type { Order } from "../lib/types";

/**
 * OrderConfirmedScreen — mockup screen 07.
 *
 * Layout (centered, white bg):
 *   1. 82x82 green gradient ring with ✅ emoji + halo glow + successPop animation
 *   2. "Indent Placed!" 16px Unbounded Black
 *   3. Sub: "Payment received. Your indent is locked and confirmed for dispatch."
 *   4. Order ID pill (#HMU-... · Confirmed) with copy button
 *   5. Success card (info table) with 5 rows:
 *      - 📍 Delivery Location
 *      - 🚚 Dispatch (Tomorrow · 5:00–5:30 AM)
 *      - 📦 Items Ordered (X pcs · Y products)
 *      - 💰 Amount Paid (₹ XXX.XX ✓ in green)
 *      - 🎉 Savings Applied (only if >0, in green)
 *   6. Brand-light "Download GST Invoice (PDF)" button
 *   7. Solid brand "← Back to Home" button
 *
 * Mockup CSS reference (dealer-app.html lines 255-271):
 *   .success-screen   : padding 48/20/22, scrollable
 *   .success-ring     : 82x82, 50% radius, 135deg #16A34A → #4ADE80 gradient, font 40
 *                       box-shadow: 0 0 0 11px rgba(22,163,74,0.12), 0 7px 28px rgba(22,163,74,0.25)
 *                       animation: successPop 0.5s cubic-bezier(0.34,1.56,0.64,1) — overshoot
 *   .success-screen h2: 16 Unbounded Black, center
 *   .sub              : 11/500 ink3, mt 5 mb 14, line 1.5
 *   .order-id-pill    : bg-light, 1.5px border, 7r, 7/14 padding, 11/700 ink2
 *     pill span       : brand color, Unbounded 10
 *   .success-card     : bg-light, 1.5px border, 14r, mb 12
 *     .sc-row         : 11/12 padding, 1px border-bottom (none on last)
 *     .sri            : 17px, w 30, center
 *     .srl            : 9/600 ink3 uppercase, ls 0.4
 *     .srv            : 12/800 ink, mt 1; .paid → green
 *   .invoice-btn-s    : brand-l bg, brand text, 11r, padding 11, 11/800
 *   .home-btn         : brand bg, white, 14r, padding 13, 13/800
 *
 * RN successPop animation:
 *   We use Animated.spring with friction:5 tension:140 to recreate the
 *   cubic-bezier(0.34, 1.56, 0.64, 1) overshoot effect — this curve goes
 *   slightly past 1 and bounces back, matching CSS spec.
 */

interface OrderConfirmedScreenProps {
  /** Order ID returned by usePlaceOrder mutation */
  orderId: string;
  /** Called when "Back to Home" tapped (from App.tsx) */
  onGoHome: () => void;
}

export default function OrderConfirmedScreen({
  orderId,
  onGoHome,
}: OrderConfirmedScreenProps) {
  const insets = useSafeAreaInsets();
  const dealer = useAuthStore((s) => s.dealer);
  const ordersQuery = useMyOrders({ page: 1, limit: 10 });
  const invQuery = useMyInvoices({ pollWhilePending: true });

  // New: invoice-by-order mutation hook
  const invoiceByOrder = useInvoiceByOrder();

  // Find the just-placed order
  const order: Order | undefined = useMemo(
    () => ordersQuery.data?.data.find((o) => o.id === orderId),
    [ordersQuery.data, orderId]
  );

  // Find the matching invoice (worker generates async; may be null initially)
  const invoice = useMemo(() => {
    const invoices = invQuery.data?.invoices ?? [];
    // Try to match by id or recent-time-and-amount heuristic
    return invoices.find((i) => i.orderId === orderId);
  }, [invQuery.data, orderId]);

  // ── successPop animation (overshoot spring) ────────────────────────
  const popScale = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.spring(popScale, {
      toValue: 1,
      friction: 5,
      tension: 140,
      useNativeDriver: true,
    }).start();
  }, [popScale]);

  // ── Action handlers ────────────────────────────────────────────────
  const handleCopyId = async () => {
    try {
      await Share.share({
        message: `Indent #${prettyOrderId(orderId)}`,
        title: "Indent ID",
      });
    } catch {
      // User cancelled — silent
    }
  };

  // Updated handleDownloadInvoice — same pattern as OrdersScreen.tsx
  const handleDownloadInvoice = async () => {
    let url: string;
    try {
      url = await invoiceByOrder.mutateAsync(orderId);
    } catch (err) {
      Alert.alert(
        "Invoice Generating",
        "Your GST invoice is being prepared. Try again in a moment."
      );
      return;
    }
    try {
      await Linking.openURL(url);
    } catch {
      Alert.alert("Cannot open", "Could not open the invoice in your browser.");
    }
  };

  // ── Derived row values ─────────────────────────────────────────────
  const itemCount = order?.itemCount ?? 0;
  const productCount = order?.items.length ?? 0;
  const grandTotal = order?.grandTotal ?? 0;
  const paymentMode = order?.paymentMode ?? "upi";
  const paymentLabel = paymentMode.toUpperCase();

  const dispatchInfo = "Tomorrow · 5:00 – 5:30 AM";
  const locationLabel =
    dealer?.locationLabel
      ? `${dealer.locationLabel}${dealer.zoneName ? ` · ${dealer.zoneName}` : ""}`
      : dealer?.zoneName ?? "—";

  const { start, end } = cssAngleToPoints(135);

  return (
    <View style={[styles.root, { paddingTop: Math.max(insets.top + 20, 48) }]}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.scrollContent,
          { paddingBottom: Math.max(insets.bottom + 22, 30) },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {/* Success ring */}
        <View style={styles.ringHalo}>
          <Animated.View style={{ transform: [{ scale: popScale }] }}>
            <LinearGradient
              colors={["#16A34A", "#4ADE80"] as unknown as [string, string]}
              start={start}
              end={end}
              style={styles.ring}
            >
              <Text style={styles.ringIcon}>✅</Text>
            </LinearGradient>
          </Animated.View>
        </View>

        {/* Heading */}
        <Text style={styles.title}>Indent Placed!</Text>
        <Text style={styles.sub}>
          Payment received.{"\n"}
          Your indent is locked and confirmed for dispatch.
        </Text>

        {/* Order ID pill */}
        <View style={styles.idPill}>
          <Text style={styles.idPillNum}>#{prettyOrderId(orderId)}</Text>
          <Text style={styles.idPillSep}>·</Text>
          <Text style={styles.idPillStatus}>Confirmed</Text>
          <TouchableOpacity
            onPress={handleCopyId}
            activeOpacity={0.7}
            style={styles.idPillCopy}
            accessibilityLabel="Share order ID"
          >
            <Text style={styles.idPillCopyIcon}>📋</Text>
          </TouchableOpacity>
        </View>

        {/* Success info card */}
        <View style={styles.card}>
          <SuccessRow icon="📍" label="Delivery Location" value={locationLabel} />
          <SuccessRow icon="🚚" label="Dispatch" value={dispatchInfo} />
          <SuccessRow
            icon="📦"
            label="Items Ordered"
            value={`${itemCount} pcs · ${productCount} product${productCount !== 1 ? "s" : ""}`}
          />
          <SuccessRow
            icon="💰"
            label={`Amount Paid (${paymentLabel})`}
            value={`₹ ${grandTotal.toFixed(2)} ✓`}
            paid
            isLast={!order || true}
          />
        </View>

        {/* Download Invoice */}
        <TouchableOpacity
          onPress={handleDownloadInvoice}
          activeOpacity={0.85}
          style={styles.invoiceBtn}
          accessibilityRole="button"
        >
          <Text style={styles.invoiceBtnText}>📄 Download GST Invoice (PDF)</Text>
        </TouchableOpacity>

        {/* Back to Home */}
        <TouchableOpacity
          onPress={onGoHome}
          activeOpacity={0.85}
          style={styles.homeBtn}
          accessibilityRole="button"
        >
          <Text style={styles.homeBtnText}>← Back to Home</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

// ════════════════════════════════════════════════════════════════════════
// SuccessRow
// ════════════════════════════════════════════════════════════════════════

interface SuccessRowProps {
  icon: string;
  label: string;
  value: string;
  paid?: boolean;
  isLast?: boolean;
}

function SuccessRow({ icon, label, value, paid, isLast }: SuccessRowProps) {
  return (
    <View style={[rowStyles.row, isLast && rowStyles.rowLast]}>
      <Text style={rowStyles.icon}>{icon}</Text>
      <View style={{ flex: 1 }}>
        <Text style={rowStyles.label}>{label}</Text>
        <Text style={[rowStyles.value, paid && rowStyles.valuePaid]} numberOfLines={2}>
          {value}
        </Text>
      </View>
    </View>
  );
}

// ════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════

/** Convert UUID order id to pretty display: takes first 16 chars, uppercases. */
function prettyOrderId(orderId: string): string {
  const slug = orderId.replace(/-/g, "").slice(0, 12).toUpperCase();
  return `HMU-${slug.slice(0, 4)}-${slug.slice(4, 12)}`;
}

// ════════════════════════════════════════════════════════════════════════
// Styles
// ════════════════════════════════════════════════════════════════════════

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.card,
  },
  scroll: { flex: 1 },
  scrollContent: {
    paddingHorizontal: 20,
    alignItems: "center",
  },

  // Success ring (with halo glow approximated via outer wrapper)
  ringHalo: {
    width: 104,
    height: 104,
    borderRadius: 52,
    backgroundColor: "rgba(22,163,74,0.12)", // mockup outer halo
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 14,
    // RN drop-shadow for the second box-shadow layer (0 7px 28px green-25)
    shadowColor: "#16A34A",
    shadowOffset: { width: 0, height: 7 },
    shadowOpacity: 0.25,
    shadowRadius: 28,
    elevation: 8,
  },
  ring: {
    width: 82,                              // mockup
    height: 82,
    borderRadius: 41,
    alignItems: "center",
    justifyContent: "center",
  },
  ringIcon: {
    fontSize: 40,                           // mockup
  },

  // Title + subtitle
  title: {
    fontFamily: fonts.headingBlack,
    fontSize: 16,                           // mockup
    color: colors.foreground,
    textAlign: "center",
  },
  sub: {
    fontSize: 11,                           // mockup
    fontFamily: fonts.medium,
    color: colors.mutedForeground,
    textAlign: "center",
    marginTop: 5,
    lineHeight: 16.5,                       // 11 * 1.5
    marginBottom: 14,
  },

  // ID pill
  idPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    backgroundColor: colors.background,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: 7,
    paddingVertical: 7,                     // mockup
    paddingHorizontal: 14,
    marginBottom: 14,
  },
  idPillNum: {
    fontSize: 11,
    fontFamily: fonts.bold,
    color: colors.ink2,
  },
  idPillSep: {
    fontSize: 11,
    color: colors.mutedForeground,
  },
  idPillStatus: {
    fontFamily: fonts.headingExtra,
    fontSize: 10,                           // mockup
    color: colors.primary,
  },
  idPillCopy: {
    paddingHorizontal: 4,
  },
  idPillCopyIcon: {
    fontSize: 12,
  },

  // Success card
  card: {
    width: "100%",
    backgroundColor: colors.background,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: 14,
    overflow: "hidden",
    marginBottom: 12,
  },

  // Buttons
  invoiceBtn: {
    width: "100%",
    backgroundColor: colors.primaryLight,
    borderRadius: 11,
    paddingVertical: 11,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 7,
    marginBottom: 9,
  },
  invoiceBtnText: {
    fontSize: 11,
    fontFamily: fonts.extrabold,
    color: colors.primary,
  },
  homeBtn: {
    width: "100%",
    backgroundColor: colors.primary,
    borderRadius: 14,
    paddingVertical: 13,
    alignItems: "center",
  },
  homeBtnText: {
    fontSize: 13,
    fontFamily: fonts.extrabold,
    color: colors.primaryForeground,
  },
});

const rowStyles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    paddingVertical: 11,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  rowLast: {
    borderBottomWidth: 0,
  },
  icon: {
    fontSize: 17,
    width: 30,
    textAlign: "center",
  },
  label: {
    fontSize: 9,
    fontFamily: fonts.semibold,
    color: colors.mutedForeground,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  value: {
    fontSize: 12,
    fontFamily: fonts.extrabold,
    color: colors.foreground,
    marginTop: 1,
  },
  valuePaid: {
    color: colors.success,
  },
});