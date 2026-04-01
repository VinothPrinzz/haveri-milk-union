import React from "react";
import { View, Text, TouchableOpacity, StyleSheet, StatusBar } from "react-native";
import { colors } from "../lib/theme";
import { formatCurrency } from "../lib/utils";

interface Props { orderId: string; onGoHome: () => void; }

export default function OrderConfirmedScreen({ orderId, onGoHome }: Props) {
  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" />
      <View style={styles.ring}><Text style={styles.checkIcon}>✅</Text></View>
      <Text style={styles.title}>Indent Placed!</Text>
      <Text style={styles.subtitle}>Payment received. Your indent is locked and confirmed for dispatch.</Text>

      <View style={styles.idPill}>
        <Text style={styles.idText}>#{orderId?.slice(0, 16) || "HMU-2025-XXXXX"}</Text>
        <Text style={styles.idStatus}> · Confirmed</Text>
      </View>

      <View style={styles.card}>
        <View style={styles.row}><Text style={styles.rowIcon}>📍</Text><View><Text style={styles.rowLabel}>Delivery Location</Text><Text style={styles.rowVal}>Haveri Main Market · Zone A</Text></View></View>
        <View style={styles.row}><Text style={styles.rowIcon}>🚚</Text><View><Text style={styles.rowLabel}>Dispatch</Text><Text style={styles.rowVal}>Tomorrow · 5:00–5:30 AM</Text></View></View>
        <View style={styles.row}><Text style={styles.rowIcon}>💰</Text><View><Text style={styles.rowLabel}>Amount Paid</Text><Text style={[styles.rowVal, { color: colors.success }]}>Confirmed ✓</Text></View></View>
      </View>

      <TouchableOpacity style={styles.invoiceBtn}><Text style={styles.invoiceBtnText}>📄 Download GST Invoice (PDF)</Text></TouchableOpacity>
      <TouchableOpacity style={styles.homeBtn} onPress={onGoHome}><Text style={styles.homeBtnText}>← Back to Home</Text></TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff", alignItems: "center", justifyContent: "center", padding: 24 },
  ring: { width: 80, height: 80, borderRadius: 40, backgroundColor: colors.successLight, alignItems: "center", justifyContent: "center", marginBottom: 16 },
  checkIcon: { fontSize: 40 },
  title: { fontSize: 24, fontWeight: "900", color: colors.fg, marginBottom: 8 },
  subtitle: { fontSize: 13, color: colors.mutedFg, textAlign: "center", fontWeight: "500", lineHeight: 20, marginBottom: 16 },
  idPill: { flexDirection: "row", backgroundColor: colors.brandLight, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 8, marginBottom: 20 },
  idText: { fontSize: 12, fontWeight: "800", color: colors.brand },
  idStatus: { fontSize: 12, fontWeight: "600", color: colors.brand },
  card: { backgroundColor: colors.bg, borderRadius: 16, padding: 16, width: "100%", gap: 14, marginBottom: 20 },
  row: { flexDirection: "row", gap: 12 },
  rowIcon: { fontSize: 18, marginTop: 2 },
  rowLabel: { fontSize: 11, color: colors.mutedFg, fontWeight: "600" },
  rowVal: { fontSize: 13, fontWeight: "700", color: colors.fg, marginTop: 2 },
  invoiceBtn: { backgroundColor: colors.brandLight, borderRadius: 14, height: 48, width: "100%", alignItems: "center", justifyContent: "center", marginBottom: 10 },
  invoiceBtnText: { fontSize: 14, fontWeight: "700", color: colors.brand },
  homeBtn: { height: 48, width: "100%", alignItems: "center", justifyContent: "center" },
  homeBtnText: { fontSize: 14, fontWeight: "700", color: colors.mutedFg },
});
