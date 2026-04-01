import React from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { formatCurrency } from "../lib/utils";
import { useCartStore } from "../store/cart";

interface Props { onPress: () => void; variant?: "open" | "warning"; }

export default function StickyCart({ onPress, variant = "open" }: Props) {
  const itemCount = useCartStore((s) => s.getItemCount());
  const grandTotal = useCartStore((s) => s.getGrandTotal());
  const items = useCartStore((s) => s.getItems());
  if (itemCount === 0) return null;

  const bg = variant === "warning" ? "#92400E" : "#0F172A";
  const ctaText = variant === "warning" ? "Pay Now ⚡" : "Review Indent →";

  return (
    <TouchableOpacity style={[s.wrap, { backgroundColor: bg }]} onPress={onPress} activeOpacity={0.9}>
      <View style={s.count}><Text style={s.countText}>{itemCount}</Text></View>
      <View style={s.info}>
        <Text style={s.items}>{itemCount} items · {items.length} products</Text>
        <Text style={s.total}>{formatCurrency(grandTotal)}</Text>
      </View>
      <Text style={s.cta}>{ctaText}</Text>
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  wrap: { flexDirection: "row", alignItems: "center", marginHorizontal: 12, marginBottom: 9, borderRadius: 14, padding: 12, gap: 11, shadowColor: "#000", shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.25, shadowRadius: 12, elevation: 8 },
  count: { backgroundColor: "#FCD34D", minWidth: 26, height: 26, borderRadius: 7, alignItems: "center", justifyContent: "center", paddingHorizontal: 5 },
  countText: { fontSize: 12, fontWeight: "900", color: "#0F172A" },
  info: { flex: 1 },
  items: { fontSize: 9, color: "rgba(255,255,255,0.5)", fontWeight: "600" },
  total: { fontSize: 14, fontWeight: "900", color: "#fff", marginTop: 1 },
  cta: { fontSize: 11, fontWeight: "800", color: "#FCD34D" },
});
