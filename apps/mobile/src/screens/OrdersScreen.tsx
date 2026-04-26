import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
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
import { useAuthStore } from "../store/auth";
import { useCartStore } from "../store/cart";
import { useMyOrders, useCancelOrder, useReorder } from "../hooks/useOrders";
import { useProducts } from "../hooks/useProducts";
import { useMyInvoices, useInvoiceByOrder } from "../hooks/useInvoices";
import type { Order, OrderStatus } from "../lib/types";
import { ApiError } from "../lib/api";

/**
 * OrdersScreen — mockup screen 08.
 *
 * Three layout sections:
 *   1. Header: "My Orders" + horizontal filter pill scroll
 *   2. Active order hero card (gradient with truck watermark) — pinned, only shows
 *      when there's a confirmed/dispatched order placed today
 *   3. Past orders list (white cards) with item chips, total, and per-status actions
 *
 * Mockup CSS reference (dealer-app.html lines 274-308):
 *   .orders-hdr     : white, padding 42/16/12, 1px border-bottom
 *   .orders-hdr h3  : 15px Unbounded ExtraBold
 *   .filter-scroll  : flex gap 6, mt 10
 *   .f-tab          : 6/12 padding, 999r, 1.5px border, 10/700 ink3, bg-light
 *   .f-tab.active   : brand bg/border, white
 *   .active-order-card : 135deg brand->#0D2B8F, 14r, padding 13, mb 10
 *     ::after = 🚚 watermark right-13 50% scale 2.2 opacity 0.1
 *     .aoc-label  : 8/800 white60, uppercase, ls 1, mb 7
 *     .aoc-id     : 11/800 white
 *     .aoc-status : flex gap 5 mt 5; dot 6x6 #4ADE80 pulse 1.5s
 *     .aoc-bottom : flex space-between mt 11
 *     .aoc-amount : 14 Unbounded ExtraBold white
 *     .aoc-invoice: 9/700 #FCD34D, bg rgba(252,211,77,0.15), 4/9 padding, 7r
 *   .order-card   : white 14r padding 12 shadow-sm mb 9
 *     .oc-id      : 11/800 ink
 *     .oc-date    : 9/500 ink3 mt 2
 *     .status-chip: 3/9 padding, 999r, 9/800
 *       .paid     : green-l bg, green text
 *       .pending  : amber-l bg, amber text
 *       .cancelled: red-l bg, red text
 *     .item-chip  : bg-light, 1px border, 7r, 2/7 padding, 9/600 ink2
 *     .oc-total   : 13/900 brand Unbounded
 *     .oc-action  : 9/700, 4/9 padding, 7r
 *       .reorder  : brand-l bg, brand text
 *       .invoice  : bg-light, 1px border, ink3
 *       .cancel   : red-l bg, red text
 */

type FilterId =
  | "all"
  | "today"
  | "this_week"
  | "paid"
  | "pending"
  | "cancelled";

interface FilterDef {
  id: FilterId;
  label: string;
  /** Backend status filter; undefined = no server filter */
  apiStatus?: OrderStatus;
}

const FILTERS: ReadonlyArray<FilterDef> = [
  { id: "all",        label: "All" },
  { id: "today",      label: "Today" },
  { id: "this_week",  label: "This Week" },
  { id: "paid",       label: "Paid" },
  { id: "pending",    label: "Pending",   apiStatus: "pending" },
  { id: "cancelled",  label: "Cancelled", apiStatus: "cancelled" },
];

export default function OrdersScreen() {
  const insets = useSafeAreaInsets();
  const dealer = useAuthStore((s) => s.dealer);
  const products = useProducts().data ?? [];
  const addItem = useCartStore((s) => s.addItem);

  const [activeFilter, setActiveFilter] = useState<FilterId>("all");
  const [refreshing, setRefreshing] = useState(false);
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  // Translate filter to API params
  const apiStatus = FILTERS.find((f) => f.id === activeFilter)?.apiStatus;
  const ordersQuery = useMyOrders({ page: 1, limit: 50, status: apiStatus });
  const invoicesQuery = useMyInvoices();
  const cancelOrder = useCancelOrder();
  const reorder = useReorder();
  const invoiceByOrder = useInvoiceByOrder();

  // Client-side filters (today/this_week/paid)
  const filteredOrders = useMemo(() => {
    const orders = ordersQuery.data?.data ?? [];
    if (activeFilter === "today")     return filterToday(orders);
    if (activeFilter === "this_week") return filterThisWeek(orders);
    if (activeFilter === "paid")      return orders.filter(isPaidStatus);
    return orders;
  }, [ordersQuery.data, activeFilter]);

  // The active-order pinned card — most recent paid order from today
  const activeOrder = useMemo(() => {
    const orders = ordersQuery.data?.data ?? [];
    const today = startOfToday();
    return orders.find(
      (o) =>
        new Date(o.createdAt).getTime() >= today &&
        (o.status === "confirmed" || o.status === "dispatched")
    );
  }, [ordersQuery.data]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await Promise.all([ordersQuery.refetch(), invoicesQuery.refetch()]);
    } finally {
      setRefreshing(false);
    }
  };

  // ── Action handlers ────────────────────────────────────────────────

  // Replace the handleViewInvoice body
  const handleViewInvoice = async (orderId: string) => {
    // First check the cached invoice list (cheap, no roundtrip if R2 URL exists)
    const cached = invoicesQuery.data?.invoices.find((i) => i.orderId === orderId);
    if (cached?.pdfUrl && !cached.pdfUrl.startsWith("data:")) {
      try {
        await Linking.openURL(cached.pdfUrl);
        return;
      } catch {
        // fall through to mutation
      }
    }

    // Otherwise fetch a fresh signed URL
    let url: string;
    try {
      url = await invoiceByOrder.mutateAsync(orderId);
    } catch (err) {
      Alert.alert("Invoice Error", "Could not fetch the invoice. Please try again.");
      return;
    }

    try {
      await Linking.openURL(url);
    } catch {
      Alert.alert(
        "Cannot open",
        "Could not open the invoice in your browser. Please try again."
      );
    }
  };

  const handleReorder = async (orderId: string) => {
    try {
      const result = await reorder.mutateAsync(orderId);
      // Push every available item into the cart
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
            gstPercent: product.gstPercent,
          });
        }
        added++;
      }
      Alert.alert(
        "Items Added",
        `${added} product${added !== 1 ? "s" : ""} added to your cart${
          skipped ? ` (${skipped} unavailable and skipped)` : ""
        }.`
      );
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Reorder failed.";
      Alert.alert("Error", msg);
    }
  };

  const handleCancel = (order: Order) => {
    Alert.alert(
      "Cancel Order?",
      `Are you sure you want to cancel order #${order.id.slice(0, 8).toUpperCase()}? Cancellation may require admin approval.`,
      [
        { text: "Keep Order", style: "cancel" },
        {
          text: "Yes, Cancel",
          style: "destructive",
          onPress: async () => {
            setCancellingId(order.id);
            try {
              await cancelOrder.mutateAsync({
                orderId: order.id,
                reason: "Dealer requested cancellation",
              });
              Alert.alert("Cancellation Requested", "Awaiting admin approval.");
            } catch (err) {
              const msg = err instanceof ApiError ? err.message : "Cancel failed.";
              Alert.alert("Error", msg);
            } finally {
              setCancellingId(null);
            }
          },
        },
      ]
    );
  };

  // ── Render ─────────────────────────────────────────────────────────

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
      {/* Header with filter pills */}
      <View style={[styles.header, { paddingTop: Math.max(insets.top + 8, 42) }]}>
        <Text style={styles.headerTitle}>My Orders</Text>
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
                activeOpacity={0.75}
                onPress={() => setActiveFilter(f.id)}
                style={[styles.fTab, active && styles.fTabActive]}
              >
                <Text style={[styles.fTabText, active && styles.fTabTextActive]}>
                  {f.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>

      {/* Body */}
      <ScrollView
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
      >
        {/* Active order card (only when there's a paid order from today) */}
        {activeFilter === "all" && activeOrder && (
          <ActiveOrderCard
            order={activeOrder}
            onInvoice={() => handleViewInvoice(activeOrder.id)}
          />
        )}

        {/* Empty state */}
        {filteredOrders.length === 0 && (
          <View style={styles.empty}>
            <Text style={styles.emptyEmoji}>📋</Text>
            <Text style={styles.emptyTitle}>No orders yet</Text>
            <Text style={styles.emptySub}>
              {activeFilter === "all"
                ? "Your placed indents will appear here."
                : "Try a different filter."}
            </Text>
          </View>
        )}

        {/* Past orders */}
        {filteredOrders
          .filter((o) => !activeOrder || o.id !== activeOrder.id || activeFilter !== "all")
          .map((order) => (
            <OrderCard
              key={order.id}
              order={order}
              productEmojis={emojiMapForOrder(order, products)}
              cancelling={cancellingId === order.id}
              onReorder={() => handleReorder(order.id)}
              onInvoice={() => handleViewInvoice(order.id)}
              onCancel={() => handleCancel(order)}
            />
          ))}
      </ScrollView>
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
  cancelling: boolean;
  onReorder: () => void;
  onInvoice: () => void;
  onCancel: () => void;
}

function OrderCard({
  order,
  productEmojis,
  cancelling,
  onReorder,
  onInvoice,
  onCancel,
}: OrderCardProps) {
  const chip = chipForStatus(order);   // ← Updated: now passes full order
  const showCancel = 
    order.status === "pending" &&
    order.cancellationStatus !== "pending" &&
    order.cancellationStatus !== "approved";

  const showInvoice = order.status !== "cancelled" && order.status !== "pending";
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

          {/* Updated Cancel Button Logic */}
          {showCancel && (
            <TouchableOpacity
              onPress={onCancel}
              disabled={cancelling}
              activeOpacity={0.75}
              style={[cardStyles.action, cardStyles.actionCancel]}
            >
              {cancelling ? (
                <ActivityIndicator color={colors.destructive} size="small" />
              ) : (
                <Text style={[cardStyles.actionText, cardStyles.actionTextCancel]}>✕ Cancel</Text>
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
  if (order.cancellationStatus === "pending") {
    return {
      label: "⏳ Cancellation Pending",
      style: cardStyles.chipPending,
      textStyle: cardStyles.chipTextPending,
    };
  }
  if (order.status === "cancelled") {
    return {
      label: "✕ Cancelled",
      style: cardStyles.chipCancelled,
      textStyle: cardStyles.chipTextCancelled,
    };
  }
  if (order.status === "pending") {
    return {
      label: "⏳ Pending",
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

function formatRelativeDate(iso: string | null | undefined): string {
  if (!iso) return "Recently";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "Recently";

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
  actionCancel:     { backgroundColor: colors.destructiveLight },
  actionText:       { fontSize: 9, fontFamily: fonts.bold },
  actionTextReorder:{ color: colors.primary },
  actionTextInvoice:{ color: colors.mutedForeground },
  actionTextCancel: { color: colors.destructive },
});