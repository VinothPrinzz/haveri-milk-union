import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Linking,
  RefreshControl,
  ScrollView,
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
  shadows,
} from "../lib/theme";
import LivePulseDot from "../components/LivePulseDot";
import AppHeader from "../components/AppHeader";
import { useAuthStore } from "../store/auth";
import { useCartStore } from "../store/cart";
import { useMyOrders, useReorder } from "../hooks/useOrders";
import { useOrderPayment, RazorpayCancelled, RazorpayFailed } from "../hooks/useOrderPayment";
import { useProducts } from "../hooks/useProducts";
import { useMyInvoices, useInvoiceByOrder } from "../hooks/useInvoices";
import type { Order, OrderStatus } from "../lib/types";
import { ApiError } from "../lib/api";

/**
 * OrdersScreen — Updated with FlatList + Infinite Scroll + Date Range Filter
 */

// ── Date Range Presets ─────────────────────────────────────────────
type RangeId = "all" | "7d" | "30d" | "month";

const ymd = (d: Date) => d.toISOString().slice(0, 10);

function rangeFor(id: RangeId): { from?: string; to?: string } {
  const now = new Date();
  if (id === "7d")
    return { from: ymd(new Date(Date.now() - 7 * 864e5)), to: ymd(now) };
  if (id === "30d")
    return { from: ymd(new Date(Date.now() - 30 * 864e5)), to: ymd(now) };
  if (id === "month")
    return {
      from: ymd(new Date(now.getFullYear(), now.getMonth(), 1)),
      to: ymd(now),
    };
  return {};
}

const RANGES: { id: RangeId; label: string }[] = [
  { id: "all", label: "All time" },
  { id: "7d", label: "Last 7 days" },
  { id: "30d", label: "Last 30 days" },
  { id: "month", label: "This month" },
];

// ── Status Filters ────────────────────────────────────────────────
type FilterId = "all" | "paid" | "confirmed" | "cancelled";

interface FilterDef {
  id: FilterId;
  label: string;
  apiStatus?: OrderStatus;
}

const FILTERS: ReadonlyArray<FilterDef> = [
  { id: "all",       label: "All" },
  { id: "paid",      label: "Paid" },
  { id: "confirmed", label: "Confirmed", apiStatus: "confirmed" },
  { id: "cancelled", label: "Cancelled", apiStatus: "cancelled" },
];

interface OrdersScreenProps {
  onOpenNotifications: () => void;
  onOpenProfile: () => void;
  onOpenPriceChart: () => void;
  onOpenInvoices: () => void;
}

export default function OrdersScreen({
  onOpenNotifications,
  onOpenProfile,
  onOpenPriceChart,
  onOpenInvoices,
}: OrdersScreenProps) {
  const insets = useSafeAreaInsets();
  const dealer = useAuthStore((s) => s.dealer);
  const products = useProducts().data ?? [];
  const addItem = useCartStore((s) => s.addItem);

  const [activeFilter, setActiveFilter] = useState<FilterId>("all");
  const [range, setRange] = useState<RangeId>("all");
  const [refreshing, setRefreshing] = useState(false);

  const { from, to } = rangeFor(range);
  const apiStatus = FILTERS.find((f) => f.id === activeFilter)?.apiStatus;

  const ordersQuery = useMyOrders({
    limit: 20,
    status: apiStatus,
    from,
    to,
  });

  const invoicesQuery = useMyInvoices();
  const reorder = useReorder();
  const invoiceByOrder = useInvoiceByOrder();

  // ── Razorpay pay-now for payment_required orders ──────────────────
  const [payOrderId, setPayOrderId] = useState<string | null>(null);
  const orderPayment = useOrderPayment(payOrderId ?? "");

  const {
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = ordersQuery;

  const orders = ordersQuery.data?.orders ?? [];

  // Active order (still client-side for hero card)
  const activeOrder = useMemo(() => {
    return orders.find(
      (o) =>
        (o.status === "confirmed" || o.status === "dispatched") &&
        new Date(o.createdAt).getTime() >= startOfToday()
    );
  }, [orders]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await Promise.all([ordersQuery.refetch(), invoicesQuery.refetch()]);
    } finally {
      setRefreshing(false);
    }
  };

  // Action handlers (unchanged)
  const handleViewInvoice = async (orderId: string) => {
    const cached = invoicesQuery.data?.invoices.find((i) => i.orderId === orderId);
    if (cached?.pdfUrl && !cached.pdfUrl.startsWith("data:")) {
      try {
        await Linking.openURL(cached.pdfUrl);
        return;
      } catch {}
    }

    try {
      const url = await invoiceByOrder.mutateAsync(orderId);
      await Linking.openURL(url);
    } catch (err) {
      Alert.alert("Invoice Error", "Could not fetch or open the invoice.");
    }
  };

  const handleReorder = async (orderId: string) => {
    try {
      const result = await reorder.mutateAsync(orderId);
      let added = 0;
      let skipped = 0;

      for (const it of result.items) {
        const product = products.find((p) => p.id === it.productId);
        if (!product || !product.available || product.stock < it.quantity) {
          skipped++;
          continue;
        }
        for (let i = 0; i < it.quantity; i++) {
          addItem({
            id: product.id,
            name: product.name,
            icon: product.icon ?? "📦",
            unit: product.unit,
            basePrice: product.basePrice,
            dealerPrice: product.dealerPrice,
            mrp: product.mrp ?? product.basePrice,
            gstPercent: product.gstPercent,
          });
        }
        added++;
      }

      Alert.alert(
        "Items Added",
        `${added} product${added !== 1 ? "s" : ""} added to your cart${
          skipped ? ` (${skipped} unavailable)` : ""
        }.`
      );
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Reorder failed.";
      Alert.alert("Error", msg);
    }
  };

  const handlePayNow = (orderId: string) => {
    setPayOrderId(orderId);
  };

  // Opens Razorpay once a payment_required orderId is set, then clears it.
  useEffect(() => {
    if (!payOrderId) return;
    let cancelled = false;

    (async () => {
      try {
        await orderPayment.mutateAsync();
        if (cancelled) return;
        setPayOrderId(null);
        Alert.alert("Payment Successful", "Your order has been confirmed.");
      } catch (err) {
        if (cancelled) return;
        setPayOrderId(null);
        if (err instanceof RazorpayCancelled) {
          Alert.alert(
            "Payment Cancelled",
            "You can try paying again from this screen."
          );
          return;
        }
        Alert.alert(
          "Payment Failed",
          err instanceof RazorpayFailed
            ? err.description || "Please try again."
            : err instanceof Error
              ? err.message
              : "Please try again."
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [payOrderId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Render ───────────────────────────────────────────────────────
  if (ordersQuery.isLoading && !ordersQuery.data) {
    return (
      <View style={styles.firstLoad}>
        <ActivityIndicator color={colors.primary} size="large" />
        <Text style={styles.firstLoadText}>Loading orders…</Text>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <AppHeader
        title="My Orders"
        onBellPress={onOpenNotifications}
        onProfilePress={onOpenProfile}
        onPriceChartPress={onOpenPriceChart}
      />

      {/* Status Filter Pills */}
      <View style={styles.filterContainer}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterScroll}
        >
          {FILTERS.map((f) => {
            const active = f.id === activeFilter;
            return (
              <TouchableOpacity
                key={f.id}
                onPress={() => setActiveFilter(f.id)}
                style={[styles.fTab, active && styles.fTabActive]}
                activeOpacity={0.75}
              >
                <Text style={[styles.fTabText, active && styles.fTabTextActive]}>
                  {f.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>

        {/* Date Range Filter Pills */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterScroll}
        >
          {RANGES.map((r) => {
            const active = r.id === range;
            return (
              <TouchableOpacity
                key={r.id}
                onPress={() => setRange(r.id)}
                style={[styles.fTab, active && styles.fTabActive]}
                activeOpacity={0.75}
              >
                <Text style={[styles.fTabText, active && styles.fTabTextActive]}>
                  {r.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>

      {/* FlatList with Infinite Scroll */}
      <FlatList
        data={orders}
        keyExtractor={(o) => o.id}
        style={styles.body}
        contentContainerStyle={styles.bodyContent}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={colors.primary}
          />
        }
        ListHeaderComponent={
          activeFilter === "all" && range === "all" && activeOrder ? (
            <ActiveOrderCard
              order={activeOrder}
              onInvoice={() => handleViewInvoice(activeOrder.id)}
            />
          ) : null
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyEmoji}>📋</Text>
            <Text style={styles.emptyTitle}>No orders</Text>
            <Text style={styles.emptySub}>
              Try a different filter or date range.
            </Text>
          </View>
        }
        renderItem={({ item: order }) => (
          <OrderCard
            key={order.id}
            order={order}
            productEmojis={emojiMapForOrder(order, products)}
            paying={payOrderId === order.id}
            onReorder={() => handleReorder(order.id)}
            onInvoice={() => handleViewInvoice(order.id)}
            onPayNow={() => handlePayNow(order.id)}
          />
        )}
        onEndReached={() => {
          if (hasNextPage) fetchNextPage();
        }}
        onEndReachedThreshold={0.5}
        ListFooterComponent={
          isFetchingNextPage ? (
            <ActivityIndicator style={{ marginVertical: 24 }} color={colors.primary} />
          ) : null
        }
      />
    </View>
  );
}

// ════════════════════════════════════════════════════════════════════════
// ActiveOrderCard
// ════════════════════════════════════════════════════════════════════════

interface ActiveOrderCardProps {
  order: Order;
  onInvoice: () => void;
}

function ActiveOrderCard({ order, onInvoice }: ActiveOrderCardProps) {
  const { start, end } = cssAngleToPoints(135);
  const statusText =
    order.status === "confirmed"
      ? "Payment confirmed · Dispatch tomorrow 5 AM"
      : order.status === "dispatched"
      ? "Dispatched · Out for delivery"
      : order.status === "delivered"
      ? "Delivered today"
      : order.status;

  return (
    <LinearGradient
      colors={["#1448CC", "#0D2B8F"] as unknown as [string, string]}
      start={start}
      end={end}
      style={activeStyles.card}
    >
      <Text style={activeStyles.watermark}>🚚</Text>
      <Text style={activeStyles.label}>Active · Today's Indent</Text>
      <Text style={activeStyles.id}>
        #{order.id.slice(0, 16).toUpperCase()} · {order.itemCount} items
      </Text>
      <View style={activeStyles.statusRow}>
        <LivePulseDot color={colors.dotGreen} speed="slow" size={6} />
        <Text style={activeStyles.statusTxt}>{statusText}</Text>
      </View>
      <View style={activeStyles.bottom}>
        <Text style={activeStyles.amount}>₹ {order.grandTotal.toFixed(2)}</Text>
        <TouchableOpacity onPress={onInvoice} activeOpacity={0.85} style={activeStyles.invoiceBtn}>
          <Text style={activeStyles.invoiceText}>📄 Invoice</Text>
        </TouchableOpacity>
      </View>
    </LinearGradient>
  );
}

// ════════════════════════════════════════════════════════════════════════
// OrderCard (past order)
// ════════════════════════════════════════════════════════════════════════

interface OrderCardProps {
  order: Order;
  productEmojis: Map<string, string>;
  paying?: boolean;
  onReorder: () => void;
  onInvoice: () => void;
  onPayNow?: () => void;
}

function OrderCard({
  order,
  productEmojis,
  paying = false,
  onReorder,
  onInvoice,
  onPayNow,
}: OrderCardProps) {
  const chip = chipForStatus(order);
  const showPayNow = order.status === "payment_required";

  // No invoice exists for unpaid (payment_required) orders yet.
  const showInvoice =
    order.status !== "cancelled" && order.status !== "payment_required";
  const isCancelled = order.status === "cancelled";

  return (
    <View style={cardStyles.card}>
      {/* Top: id + chip */}
      <View style={cardStyles.top}>
        <View style={{ flex: 1 }}>
          <Text style={cardStyles.id}>
            #{order.id.slice(0, 16).toUpperCase()}
          </Text>
          <Text style={cardStyles.date}>
            {formatRelativeDate(order.createdAt)} · {order.itemCount} items
          </Text>
        </View>
        <View style={[cardStyles.chip, chip.style]}>
          <Text style={[cardStyles.chipText, chip.textStyle]}>{chip.label}</Text>
        </View>
      </View>

      {/* Item chips row */}
      {order.items.length > 0 && (
        <View style={cardStyles.itemsRow}>
          {order.items.slice(0, 5).map((item, idx) => {
            const emoji = item.productId
              ? productEmojis.get(item.productId) ?? "📦"
              : "📦";
            return (
              <View key={`${item.productName}-${idx}`} style={cardStyles.itemChip}>
                <Text style={cardStyles.itemChipEmoji}>{emoji}</Text>
                <Text style={cardStyles.itemChipText}>×{item.quantity}</Text>
              </View>
            );
          })}
        </View>
      )}

      {/* Footer: total + actions */}
      <View style={cardStyles.footer}>
        <Text style={[cardStyles.total, isCancelled && cardStyles.totalCancelled]}>
          ₹ {order.grandTotal.toFixed(2)}
        </Text>
        <View style={cardStyles.actions}>
          <TouchableOpacity
            onPress={onReorder}
            activeOpacity={0.75}
            style={[cardStyles.action, cardStyles.actionReorder]}
          >
            <Text style={[cardStyles.actionText, cardStyles.actionTextReorder]}>↻ Reorder</Text>
          </TouchableOpacity>

          {showInvoice && (
            <TouchableOpacity
              onPress={onInvoice}
              activeOpacity={0.75}
              style={[cardStyles.action, cardStyles.actionInvoice]}
            >
              <Text style={[cardStyles.actionText, cardStyles.actionTextInvoice]}>📄 Invoice</Text>
            </TouchableOpacity>
          )}

          {showPayNow && (
            <TouchableOpacity
              onPress={onPayNow}
              disabled={paying}
              activeOpacity={0.75}
              style={[cardStyles.action, cardStyles.actionPayNow]}
            >
              {paying ? (
                <ActivityIndicator color={colors.warning} size="small" />
              ) : (
                <Text style={[cardStyles.actionText, cardStyles.actionTextPayNow]}>💳 Pay Now</Text>
              )}
            </TouchableOpacity>
          )}
        </View>
      </View>
    </View>
  );
}

// ════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════

function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function startOfThisWeek(): number {
  const d = new Date();
  const day = d.getDay(); // Sunday = 0
  d.setDate(d.getDate() - day);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function filterToday(orders: Order[]): Order[] {
  const today = startOfToday();
  return orders.filter((o) => new Date(o.createdAt).getTime() >= today);
}

function filterThisWeek(orders: Order[]): Order[] {
  const start = startOfThisWeek();
  return orders.filter((o) => new Date(o.createdAt).getTime() >= start);
}

function isPaidStatus(o: Order): boolean {
  return o.status === "confirmed" || o.status === "dispatched" || o.status === "delivered";
}

function chipForStatus(order: Order) {   // ← Updated: now takes full Order
  if (order.status === "cancelled") {
    return {
      label: "✕ Cancelled",
      style: cardStyles.chipCancelled,
      textStyle: cardStyles.chipTextCancelled,
    };
  }
  if (order.status === "payment_required") {
    return {
      label: "💳 Awaiting Payment",
      style: cardStyles.chipPending,
      textStyle: cardStyles.chipTextPending,
    };
  }
  // confirmed, dispatched, delivered all show as Paid
  return {
    label: "✓ Paid",
    style: cardStyles.chipPaid,
    textStyle: cardStyles.chipTextPaid,
  };
}

// Robust timestamp parser. React Native's Hermes engine is strict about
// Date strings and returns Invalid Date for the Postgres text format
// ("2026-05-30 00:49:00.123+00" — space separator, short "+00" offset),
// which is why every order was rendering "Recently". This normalizes the
// common shapes (ISO, Postgres text, epoch, Date) to a valid Date or null.
function parseServerDate(v: string | number | Date | null | undefined): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (typeof v === "number") {
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  if (typeof v !== "string" || v.trim() === "") return null;

  const s = v.trim();
  // Native parse first — handles proper ISO ("…T…Z" / "…T…+05:30").
  let d = new Date(s);
  if (!isNaN(d.getTime())) return d;

  // Postgres text format → ISO: space to "T", pad/normalize the offset.
  let t = s.replace(" ", "T");
  if (/[zZ]$/.test(t)) {
    // already zulu
  } else {
    const m = t.match(/([+-]\d{2})(?::?(\d{2}))?$/);
    if (m) {
      t = t.replace(/([+-]\d{2})(?::?(\d{2}))?$/, `${m[1]}:${m[2] ?? "00"}`);
    } else {
      t = `${t}Z`; // naive timestamp → assume UTC
    }
  }
  d = new Date(t);
  return isNaN(d.getTime()) ? null : d;
}

function formatRelativeDate(iso: string | null | undefined): string {
  const d = parseServerDate(iso);
  if (!d) return "Recently";

  const today = startOfToday();
  const diffDays = Math.floor((today - new Date(d).setHours(0,0,0,0)) / 86_400_000);

  let label: string;
  if (diffDays === 0)      label = "Today";
  else if (diffDays === 1) label = "Yesterday";
  else if (diffDays < 7)   label = `${diffDays} days ago`;
  else                     label = d.toLocaleDateString();

  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${label} · ${h}:${String(m).padStart(2, "0")} ${ampm}`;
}

function emojiMapForOrder(order: Order, products: { id: string; icon: string | null }[]) {
  const map = new Map<string, string>();
  for (const item of order.items) {
    if (!item.productId) continue;
    const product = products.find((p) => p.id === item.productId);
    map.set(item.productId, product?.icon ?? "📦");
  }
  return map;
}

// ════════════════════════════════════════════════════════════════════════
// Styles
// ════════════════════════════════════════════════════════════════════════

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
  },
  firstLoad: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.background,
    gap: 12,
  },
  firstLoadText: {
    fontFamily: fonts.medium,
    color: colors.mutedForeground,
    fontSize: 12,
  },

  // Header
  header: {
    backgroundColor: colors.card,
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerTitle: {
    fontFamily: fonts.headingExtra,
    fontSize: 15,                            // mockup
    color: colors.foreground,
  },
  filterContainer: {
    backgroundColor: colors.card,
    paddingHorizontal: 16,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  filterScroll: {
    gap: 6,                                  // mockup
    marginTop: 10,
    paddingRight: 16,                        // breathing room at end
  },
  fTab: {
    paddingVertical: 6,                      // mockup
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.background,
  },
  fTabActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  fTabText: {
    fontSize: 10,                            // mockup
    fontFamily: fonts.bold,
    color: colors.mutedForeground,
  },
  fTabTextActive: {
    color: colors.primaryForeground,
  },

  // Body
  body: {
    flex: 1,
  },
  bodyContent: {
    padding: 12,
    paddingBottom: 24,
  },

  // Empty
  empty: {
    alignItems: "center",
    paddingVertical: 56,
    paddingHorizontal: 24,
  },
  emptyEmoji: {
    fontSize: 48,
    marginBottom: 12,
  },
  emptyTitle: {
    fontSize: 15,
    fontFamily: fonts.extrabold,
    color: colors.foreground,
  },
  emptySub: {
    fontSize: 11,
    fontFamily: fonts.medium,
    color: colors.mutedForeground,
    marginTop: 6,
    textAlign: "center",
    lineHeight: 16,
  },
});

const activeStyles = StyleSheet.create({
  card: {
    borderRadius: 14,
    padding: 13,
    marginBottom: 10,
    position: "relative",
    overflow: "hidden",
  },
  watermark: {
    position: "absolute",
    right: 13,
    top: "50%",
    fontSize: 80,                            // ~36 * 2.2 mockup scale
    opacity: 0.1,
    transform: [{ translateY: -40 }],
  },
  label: {
    fontSize: 8,                             // mockup
    fontFamily: fonts.extrabold,
    color: "rgba(255,255,255,0.6)",
    textTransform: "uppercase",
    letterSpacing: 1,
    marginBottom: 7,
  },
  id: {
    fontSize: 11,
    fontFamily: fonts.extrabold,
    color: colors.primaryForeground,
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    marginTop: 5,
  },
  statusTxt: {
    fontSize: 10,
    fontFamily: fonts.semibold,
    color: "rgba(255,255,255,0.8)",
    flex: 1,
  },
  bottom: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 11,
  },
  amount: {
    fontFamily: fonts.headingExtra,
    fontSize: 14,
    color: colors.primaryForeground,
  },
  invoiceBtn: {
    backgroundColor: "rgba(252,211,77,0.15)",
    paddingVertical: 4,
    paddingHorizontal: 9,
    borderRadius: 7,
  },
  invoiceText: {
    fontSize: 9,
    fontFamily: fonts.bold,
    color: colors.yellowAccent,
  },
});

const cardStyles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: 14,
    padding: 12,
    marginBottom: 9,
    ...shadows.sm,
  },
  top: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 9,
  },
  id: {
    fontSize: 11,
    fontFamily: fonts.extrabold,
    color: colors.foreground,
  },
  date: {
    fontSize: 9,
    fontFamily: fonts.medium,
    color: colors.mutedForeground,
    marginTop: 2,
  },
  chip: {
    paddingVertical: 3,
    paddingHorizontal: 9,
    borderRadius: 999,
  },
  chipText: {
    fontSize: 9,
    fontFamily: fonts.extrabold,
  },
  chipPaid:           { backgroundColor: colors.successLight },
  chipPending:        { backgroundColor: colors.warningLight },
  chipCancelled:      { backgroundColor: colors.destructiveLight },
  chipTextPaid:       { color: colors.success },
  chipTextPending:    { color: colors.warning },
  chipTextCancelled:  { color: colors.destructive },

  itemsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 5,
    marginBottom: 9,
  },
  itemChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 7,
    paddingVertical: 2,
    paddingHorizontal: 7,
  },
  itemChipEmoji: {
    fontSize: 10,
  },
  itemChipText: {
    fontSize: 9,
    fontFamily: fonts.semibold,
    color: colors.ink2,
  },

  footer: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingTop: 9,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  total: {
    fontSize: 13,
    fontFamily: fonts.headingBlack,
    color: colors.primary,
  },
  totalCancelled: {
    color: colors.mutedForeground,
  },
  actions: {
    flexDirection: "row",
    gap: 5,
  },
  action: {
    paddingVertical: 4,
    paddingHorizontal: 9,
    borderRadius: 7,
    minHeight: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  actionReorder:    { backgroundColor: colors.primaryLight },
  actionInvoice:    { backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border },
  actionPayNow:     { backgroundColor: colors.warningLight, borderWidth: 1, borderColor: colors.warningBorder },
  actionText:       { fontSize: 9, fontFamily: fonts.bold },
  actionTextReorder:{ color: colors.primary },
  actionTextInvoice:{ color: colors.mutedForeground },
  actionTextPayNow: { color: colors.warning },
});