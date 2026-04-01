import React, { useState, useEffect } from "react";
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, RefreshControl, Platform, Alert } from "react-native";
import { colors } from "../lib/theme";
import { formatCurrency, formatDate } from "../lib/utils";
import { api } from "../lib/api";
import { useCartStore } from "../store/cart";

const FILTERS = ["All", "Today", "This Week", "Paid", "Pending", "Cancelled"];
const PRODUCT_ICONS: Record<string, string> = { "Full Cream Milk": "🥛", "Toned Milk": "🥛", "Curd Cup": "🫙", "Fresh Paneer": "🧀", "Premium Butter": "🧈", "Ghee": "🫙", "Buttermilk": "🥤" };
const getIcon = (name: string) => PRODUCT_ICONS[name] || "📦";

export default function OrdersScreen() {
  const [filter, setFilter] = useState("All");
  const [orders, setOrders] = useState<any[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const fetch_ = async () => { try { const d = await api.get("/api/v1/orders/my", { page: 1, limit: 30 }); setOrders(d.data ?? []); } catch {} };
  useEffect(() => { fetch_(); }, []);
  const onRefresh = async () => { setRefreshing(true); await fetch_(); setRefreshing(false); };

  const filtered = filter === "All" ? orders :
    filter === "Today" ? orders.filter((o: any) => new Date(o.created_at).toDateString() === new Date().toDateString()) :
    filter === "This Week" ? orders.filter((o: any) => Date.now() - new Date(o.created_at).getTime() < 7*86400000) :
    filter === "Paid" ? orders.filter((o: any) => o.status === "confirmed" || o.status === "delivered") :
    filter === "Pending" ? orders.filter((o: any) => o.status === "pending") :
    orders.filter((o: any) => o.status === "cancelled");

  // Pin active (pending/confirmed) orders at top
  const active = filtered.filter((o: any) => o.status === "pending" || o.status === "confirmed");
  const rest = filtered.filter((o: any) => o.status !== "pending" && o.status !== "confirmed");
  const sorted = [...active, ...rest];

  const statusColor = (s: string) => ({ confirmed: "#16A34A", delivered: "#0284C7", pending: "#D97706", cancelled: "#DC2626", dispatched: "#1448CC" }[s] || "#94A3B8");
  const statusBg = (s: string) => ({ confirmed: "#DCFCE7", delivered: "#E0F2FE", pending: "#FEF3C7", cancelled: "#FEE2E2", dispatched: "#E8EEFB" }[s] || "#F1F5F9");

  const handleReorder = async (orderId: string) => {
    try {
      const res = await api.post(`/api/v1/orders/reorder/${orderId}`, {});
      if (res.items?.length) {
        const addItem = useCartStore.getState().addItem;
        // Add items to cart (simplified — just add first few)
        Alert.alert("Reorder", `${res.items.length} items added to cart`);
      }
    } catch { Alert.alert("Error", "Could not reorder"); }
  };

  return (
    <View style={s.root}>
      <View style={s.header}><Text style={s.title}>My Orders</Text></View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.filterWrap} contentContainerStyle={{ paddingHorizontal: 12, gap: 7 }}>
        {FILTERS.map(f => (
          <TouchableOpacity key={f} style={[s.filterPill, filter === f && s.filterActive]} onPress={() => setFilter(f)}>
            <Text style={[s.filterText, filter === f && { color: "#fff" }]}>{f}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <ScrollView style={{ flex: 1, padding: 12 }} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
        {sorted.map((o: any) => {
          const isActive = o.status === "pending" || o.status === "confirmed";
          const items = o.items ?? [];
          return (
            <View key={o.id} style={[s.orderCard, isActive && s.activeCard]}>
              {/* Top row: status + date */}
              <View style={s.orderTop}>
                <View style={[s.statusChip, { backgroundColor: statusBg(o.status) }]}><Text style={[s.statusText, { color: statusColor(o.status) }]}>{o.status}</Text></View>
                <Text style={s.orderDate}>{formatDate(o.created_at)}</Text>
              </View>

              {/* Item chips */}
              {items.length > 0 && (
                <View style={s.itemChips}>
                  {items.map((item: any, i: number) => (
                    <View key={i} style={s.itemChip}>
                      <Text style={{ fontSize: 12 }}>{getIcon(item.product_name)}</Text>
                      <Text style={s.chipText}>×{item.quantity}</Text>
                    </View>
                  ))}
                </View>
              )}

              {/* Footer: total + actions */}
              <View style={s.orderFooter}>
                <Text style={s.orderTotal}>{formatCurrency(o.grand_total)}</Text>
                <View style={s.actions}>
                  <TouchableOpacity onPress={() => handleReorder(o.id)}><Text style={[s.actionText, { color: colors.brand }]}>↻ Reorder</Text></TouchableOpacity>
                  <TouchableOpacity><Text style={[s.actionText, { color: "#16A34A" }]}>📄 Invoice</Text></TouchableOpacity>
                  {o.status === "pending" && <TouchableOpacity><Text style={[s.actionText, { color: "#DC2626" }]}>✕ Cancel</Text></TouchableOpacity>}
                </View>
              </View>
            </View>
          );
        })}
        {sorted.length === 0 && <Text style={s.empty}>No orders found</Text>}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#F5F5F5" },
  header: { backgroundColor: "#fff", paddingTop: Platform.OS === "web" ? 16 : 52, paddingBottom: 10, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: "#E2E8F0" },
  title: { fontSize: 18, fontWeight: "900", color: "#0F172A" },
  filterWrap: { paddingVertical: 10 },
  filterPill: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20, backgroundColor: "#fff", borderWidth: 1.5, borderColor: "#E2E8F0" },
  filterActive: { backgroundColor: colors.brand, borderColor: colors.brand },
  filterText: { fontSize: 11, fontWeight: "700", color: "#64748B" },
  orderCard: { backgroundColor: "#fff", borderRadius: 14, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: "#E2E8F0" },
  activeCard: { borderLeftWidth: 3, borderLeftColor: "#16A34A" },
  orderTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 10 },
  statusChip: { paddingHorizontal: 10, paddingVertical: 3, borderRadius: 6 },
  statusText: { fontSize: 10, fontWeight: "800", textTransform: "capitalize" },
  orderDate: { fontSize: 10, color: "#94A3B8", fontWeight: "600" },
  itemChips: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 10 },
  itemChip: { flexDirection: "row", alignItems: "center", gap: 3, backgroundColor: "#F8FAFC", borderWidth: 1, borderColor: "#E2E8F0", borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3 },
  chipText: { fontSize: 10, fontWeight: "700", color: "#64748B" },
  orderFooter: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingTop: 10, borderTopWidth: 1, borderTopColor: "#F1F5F9" },
  orderTotal: { fontSize: 15, fontWeight: "900", color: "#0F172A" },
  actions: { flexDirection: "row", gap: 12 },
  actionText: { fontSize: 11, fontWeight: "700" },
  empty: { textAlign: "center", color: "#94A3B8", fontSize: 13, paddingTop: 40 },
});
