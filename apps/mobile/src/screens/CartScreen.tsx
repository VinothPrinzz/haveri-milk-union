import React, { useState } from "react";
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, Alert, ActivityIndicator } from "react-native";
import { colors } from "../lib/theme";
import { formatCurrency } from "../lib/utils";
import { useCartStore } from "../store/cart";
import { useAuthStore } from "../store/auth";
import { api } from "../lib/api";

interface Props {
  onBack: () => void;
  onOrderPlaced: (orderId: string) => void;
}

export default function CartScreen({ onBack, onOrderPlaced }: Props) {
  const items = useCartStore((s) => s.getItems());
  const itemCount = useCartStore((s) => s.getItemCount());
  const subtotal = useCartStore((s) => s.getSubtotal());
  const totalGst = useCartStore((s) => s.getTotalGst());
  const grandTotal = useCartStore((s) => s.getGrandTotal());
  const paymentMode = useCartStore((s) => s.paymentMode);
  const setPaymentMode = useCartStore((s) => s.setPaymentMode);
  const setQuantity = useCartStore((s) => s.setQuantity);
  const clearCart = useCartStore((s) => s.clearCart);
  const dealer = useAuthStore((s) => s.dealer);
  const [placing, setPlacing] = useState(false);

  const handlePlace = async () => {
    setPlacing(true);
    try {
      const orderItems = items.map((i) => ({ productId: i.id, quantity: i.quantity }));
      const res = await api.post("/api/v1/orders", { items: orderItems, paymentMode });
      clearCart();
      onOrderPlaced(res.order?.id ?? "");
    } catch (err: any) {
      Alert.alert("Order Failed", err?.data?.message || err?.data?.error || "Something went wrong");
    } finally {
      setPlacing(false);
    }
  };

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerTop}>
          <TouchableOpacity onPress={onBack}><Text style={styles.back}>←</Text></TouchableOpacity>
          <Text style={styles.title}>Review Indent</Text>
        </View>
        <Text style={styles.headerSub}>{items.length} products · Window closes soon</Text>
        <View style={styles.deliverChip}>
          <Text style={styles.deliverIcon}>📍</Text>
          <Text style={styles.deliverText}>{dealer?.locationLabel || dealer?.zoneName || "Your Location"}</Text>
        </View>
      </View>

      <ScrollView style={styles.body} contentContainerStyle={{ paddingBottom: 200 }}>
        {/* Cart Items */}
        {items.map((item) => (
          <View key={item.id} style={styles.cartItem}>
            <Text style={styles.itemIcon}>{item.icon}</Text>
            <View style={styles.itemInfo}>
              <Text style={styles.itemName}>{item.name}</Text>
              <Text style={styles.itemMeta}>{item.unit} · {formatCurrency(item.basePrice)} · GST {item.gstPercent}%</Text>
            </View>
            <View style={styles.qtyRow}>
              <TouchableOpacity style={styles.qBtn} onPress={() => setQuantity(item.id, item.quantity - 1)}>
                <Text style={styles.qBtnText}>−</Text>
              </TouchableOpacity>
              <Text style={styles.qVal}>{item.quantity}</Text>
              <TouchableOpacity style={styles.qBtn} onPress={() => setQuantity(item.id, item.quantity + 1)}>
                <Text style={styles.qBtnText}>+</Text>
              </TouchableOpacity>
            </View>
            <Text style={styles.itemTotal}>{formatCurrency(item.lineTotal)}</Text>
          </View>
        ))}

        {/* GST Breakdown */}
        <View style={styles.summaryCard}>
          <View style={styles.summaryRow}><Text style={styles.summaryLabel}>Subtotal ({itemCount} items)</Text><Text style={styles.summaryVal}>{formatCurrency(subtotal)}</Text></View>
          <View style={styles.summaryRow}><Text style={styles.summaryLabel}>GST (CGST + SGST)</Text><Text style={styles.summaryVal}>{formatCurrency(totalGst)}</Text></View>
          <View style={[styles.summaryRow, styles.totalRow]}><Text style={styles.totalLabel}>Grand Total</Text><Text style={styles.totalVal}>{formatCurrency(grandTotal)}</Text></View>
        </View>

        {/* Cancel Policy */}
        <View style={styles.policyCard}>
          <Text style={styles.policyIcon}>ℹ️</Text>
          <Text style={styles.policyText}>Free cancellation within 5 min of ordering. After that, cancellation requires admin approval.</Text>
        </View>
      </ScrollView>

      {/* Payment Footer */}
      <View style={styles.footer}>
        <View style={styles.payModes}>
          {(["wallet", "upi", "credit"] as const).map((mode) => (
            <TouchableOpacity key={mode} style={[styles.payMode, paymentMode === mode && styles.payModeActive]} onPress={() => setPaymentMode(mode)}>
              <Text style={styles.payModeIcon}>{mode === "wallet" ? "📱" : mode === "upi" ? "💳" : "🏦"}</Text>
              <Text style={[styles.payModeLabel, paymentMode === mode && styles.payModeLabelActive]}>
                {mode === "wallet" ? "Wallet" : mode === "upi" ? "UPI" : "Credit"}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
        <TouchableOpacity style={styles.payBtn} onPress={handlePlace} disabled={placing} activeOpacity={0.8}>
          {placing ? <ActivityIndicator color="#fff" /> : <Text style={styles.payBtnText}>🔒 Pay {formatCurrency(grandTotal)} securely</Text>}
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: { backgroundColor: colors.brand, paddingTop: 48, paddingBottom: 14, paddingHorizontal: 16, borderBottomLeftRadius: 16, borderBottomRightRadius: 16 },
  headerTop: { flexDirection: "row", alignItems: "center", gap: 12 },
  back: { fontSize: 22, color: "#fff", fontWeight: "700" },
  title: { fontSize: 18, fontWeight: "900", color: "#fff" },
  headerSub: { fontSize: 11, color: "rgba(255,255,255,0.7)", fontWeight: "600", marginTop: 4, marginLeft: 34 },
  deliverChip: { flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: "rgba(255,255,255,0.15)", borderRadius: 20, paddingHorizontal: 10, paddingVertical: 5, alignSelf: "flex-start", marginTop: 8 },
  deliverIcon: { fontSize: 12 },
  deliverText: { fontSize: 11, fontWeight: "600", color: "rgba(255,255,255,0.9)" },
  body: { flex: 1, padding: 12 },
  cartItem: { flexDirection: "row", alignItems: "center", backgroundColor: "#fff", borderRadius: 12, padding: 12, marginBottom: 8, gap: 10 },
  itemIcon: { fontSize: 28 },
  itemInfo: { flex: 1 },
  itemName: { fontSize: 13, fontWeight: "800", color: colors.fg },
  itemMeta: { fontSize: 10, color: colors.mutedFg, fontWeight: "500", marginTop: 2 },
  qtyRow: { flexDirection: "row", alignItems: "center" },
  qBtn: { width: 28, height: 28, borderRadius: 7, backgroundColor: colors.brandLight, alignItems: "center", justifyContent: "center" },
  qBtnText: { fontSize: 16, fontWeight: "800", color: colors.brand },
  qVal: { width: 28, textAlign: "center", fontSize: 14, fontWeight: "900", color: colors.fg },
  itemTotal: { fontSize: 13, fontWeight: "900", color: colors.fg, minWidth: 60, textAlign: "right" },
  summaryCard: { backgroundColor: "#fff", borderRadius: 14, padding: 14, marginTop: 8 },
  summaryRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 6 },
  summaryLabel: { fontSize: 12, color: colors.mutedFg, fontWeight: "600" },
  summaryVal: { fontSize: 12, fontWeight: "700", color: colors.fg },
  totalRow: { borderTopWidth: 1, borderTopColor: colors.border, marginTop: 6, paddingTop: 10 },
  totalLabel: { fontSize: 14, fontWeight: "900", color: colors.brand },
  totalVal: { fontSize: 16, fontWeight: "900", color: colors.brand },
  policyCard: { flexDirection: "row", gap: 8, backgroundColor: colors.warningLight, borderRadius: 12, padding: 12, marginTop: 12 },
  policyIcon: { fontSize: 14 },
  policyText: { flex: 1, fontSize: 11, color: "#92400E", fontWeight: "500", lineHeight: 16 },
  footer: { backgroundColor: "#fff", borderTopWidth: 1, borderTopColor: colors.border, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 30 },
  payModes: { flexDirection: "row", gap: 10, marginBottom: 12 },
  payMode: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 10, borderRadius: 12, borderWidth: 1.5, borderColor: colors.border, backgroundColor: "#fff" },
  payModeActive: { borderColor: colors.brand, backgroundColor: colors.brandLight },
  payModeIcon: { fontSize: 16 },
  payModeLabel: { fontSize: 12, fontWeight: "700", color: colors.mutedFg },
  payModeLabelActive: { color: colors.brand },
  payBtn: { backgroundColor: colors.brand, height: 52, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  payBtnText: { fontSize: 15, fontWeight: "800", color: "#fff" },
});
