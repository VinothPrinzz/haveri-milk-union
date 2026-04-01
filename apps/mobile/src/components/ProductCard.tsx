import React from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { colors } from "../lib/theme";
import { formatCurrency } from "../lib/utils";
import { useCartStore } from "../store/cart";

interface Props {
  product: {
    id: string;
    name: string;
    icon: string;
    unit: string;
    basePrice: string;
    gstPercent: string;
    stock: number;
    available: boolean;
  };
}

export default function ProductCard({ product }: Props) {
  const cartItem = useCartStore((s) => s.items[product.id]);
  const addItem = useCartStore((s) => s.addItem);
  const removeItem = useCartStore((s) => s.removeItem);
  const qty = cartItem?.quantity ?? 0;
  const price = parseFloat(product.basePrice);
  const gst = parseFloat(product.gstPercent);
  const inStock = product.stock > 0 && product.available;

  return (
    <View style={[styles.card, !inStock && styles.cardOos]}>
      <View style={[styles.stockDot, { backgroundColor: inStock ? colors.success : colors.danger }]} />
      <Text style={styles.icon}>{product.icon}</Text>
      <Text style={styles.name}>{product.name}</Text>
      <Text style={styles.size}>{product.unit}</Text>
      <View style={styles.priceRow}>
        <Text style={styles.price}>{formatCurrency(price)}</Text>
      </View>
      <Text style={styles.gst}>Incl. GST {gst}%</Text>

      {!inStock ? (
        <View style={styles.oosBtn}><Text style={styles.oosText}>Out of Stock</Text></View>
      ) : qty > 0 ? (
        <View style={styles.qtyRow}>
          <TouchableOpacity style={styles.qBtn} onPress={() => removeItem(product.id)}>
            <Text style={styles.qBtnText}>−</Text>
          </TouchableOpacity>
          <Text style={styles.qVal}>{qty}</Text>
          <TouchableOpacity style={styles.qBtn} onPress={() => addItem({ id: product.id, name: product.name, icon: product.icon, unit: product.unit, basePrice: price, gstPercent: gst })}>
            <Text style={styles.qBtnText}>+</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <TouchableOpacity
          style={styles.addBtn}
          onPress={() => addItem({ id: product.id, name: product.name, icon: product.icon, unit: product.unit, basePrice: price, gstPercent: gst })}
        >
          <Text style={styles.addBtnText}>+ Add to Indent</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: "#fff", borderRadius: 16, padding: 12, width: "48%", marginBottom: 10, shadowColor: "#000", shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 4, elevation: 2 },
  cardOos: { opacity: 0.5 },
  stockDot: { position: "absolute", top: 8, right: 8, width: 8, height: 8, borderRadius: 4 },
  icon: { fontSize: 36, textAlign: "center", marginBottom: 6, marginTop: 4 },
  name: { fontSize: 12, fontWeight: "800", color: colors.fg, textAlign: "center" },
  size: { fontSize: 10, color: colors.mutedFg, textAlign: "center", marginTop: 2, fontWeight: "600" },
  priceRow: { flexDirection: "row", justifyContent: "center", alignItems: "baseline", marginTop: 6 },
  price: { fontSize: 16, fontWeight: "900", color: colors.fg },
  gst: { fontSize: 9, color: colors.mutedFg, textAlign: "center", marginTop: 2, fontWeight: "500" },
  addBtn: { backgroundColor: colors.brand, borderRadius: 10, paddingVertical: 8, marginTop: 8 },
  addBtnText: { fontSize: 11, fontWeight: "800", color: "#fff", textAlign: "center" },
  oosBtn: { backgroundColor: colors.dangerLight, borderRadius: 10, paddingVertical: 8, marginTop: 8 },
  oosText: { fontSize: 11, fontWeight: "700", color: colors.danger, textAlign: "center" },
  qtyRow: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 0, marginTop: 8 },
  qBtn: { width: 32, height: 32, borderRadius: 8, backgroundColor: colors.brandLight, alignItems: "center", justifyContent: "center" },
  qBtnText: { fontSize: 18, fontWeight: "800", color: colors.brand },
  qVal: { width: 36, textAlign: "center", fontSize: 16, fontWeight: "900", color: colors.fg },
});
