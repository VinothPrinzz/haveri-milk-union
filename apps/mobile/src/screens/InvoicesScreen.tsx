import React, { useState, useEffect } from "react";
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, RefreshControl, Platform } from "react-native";
import { colors } from "../lib/theme";
import { formatCurrency, formatDate } from "../lib/utils";
import { api } from "../lib/api";

export default function InvoicesScreen() {
  const [invoices, setInvoices] = useState<any[]>([]);
  const [summary, setSummary] = useState<any>({});
  const [refreshing, setRefreshing] = useState(false);

  const fetch_ = async () => {
    try {
      const d = await api.get("/api/v1/invoices/my");
      setInvoices(d.invoices ?? []);
      setSummary(d.summary ?? {});
    } catch {
      // Fallback: try orders/my
      try {
        const d = await api.get("/api/v1/orders/my", { page: 1, limit: 30 });
        setInvoices((d.data ?? []).filter((o: any) => o.status !== "cancelled"));
      } catch {}
    }
  };
  useEffect(() => { fetch_(); }, []);
  const onRefresh = async () => { setRefreshing(true); await fetch_(); setRefreshing(false); };

  const months = ["Jan 2025", "Dec 2024", "Nov 2024", "Custom range"];
  const [selectedMonth, setSelectedMonth] = useState(months[0]);

  return (
    <View style={s.root}>
      {/* Header */}
      <View style={s.header}>
        <Text style={s.title}>GST Invoices</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 10 }} contentContainerStyle={{ gap: 7 }}>
          {months.map(m => (
            <TouchableOpacity key={m} style={[s.monthPill, selectedMonth === m && s.monthActive]} onPress={() => setSelectedMonth(m)}>
              <Text style={[s.monthText, selectedMonth === m && { color: "#fff" }]}>{m}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      <ScrollView style={{ flex: 1 }} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />} contentContainerStyle={{ padding: 12 }}>
        {/* GST Summary Card */}
        <View style={s.summaryCard}>
          <Text style={s.summaryLabel}>{selectedMonth} · GST Summary</Text>
          <View style={s.summaryRow}>
            <View style={s.summaryItem}>
              <Text style={s.summaryVal}>{formatCurrency(summary.total_orders || 0)}</Text>
              <Text style={s.summaryLbl}>Total Orders</Text>
            </View>
            <View style={s.summaryItem}>
              <Text style={[s.summaryVal, { color: "#D97706" }]}>{formatCurrency(summary.total_gst || 0)}</Text>
              <Text style={s.summaryLbl}>Total GST Paid</Text>
            </View>
            <View style={s.summaryItem}>
              <Text style={s.summaryVal}>{summary.invoice_count ?? invoices.length}</Text>
              <Text style={s.summaryLbl}>Invoices</Text>
            </View>
          </View>
          <TouchableOpacity style={s.downloadAll}><Text style={s.downloadAllText}>📥 Download All Invoices (ZIP)</Text></TouchableOpacity>
        </View>

        {/* Invoice List */}
        {invoices.map((inv: any) => {
          const isInvoice = !!inv.invoice_number;
          return (
            <View key={inv.id} style={s.invCard}>
              <View style={s.invTop}>
                <View style={s.invLeft}>
                  <View style={s.invIconWrap}><Text style={{ fontSize: 16 }}>🧾</Text></View>
                  <View>
                    <Text style={s.invNum}>{isInvoice ? inv.invoice_number : `#${inv.id?.slice(0, 12)}`}</Text>
                    <Text style={s.invMeta}>{formatDate(inv.invoice_date || inv.created_at)} · {inv.item_count || "—"} items</Text>
                  </View>
                </View>
                <View style={s.invRight}>
                  <Text style={s.invAmt}>{formatCurrency(inv.total_amount || inv.grand_total)}</Text>
                  <Text style={s.invGst}>GST: {formatCurrency(inv.total_tax || inv.total_gst || 0)}</Text>
                </View>
              </View>
              <TouchableOpacity style={s.dlBtn}><Text style={s.dlBtnText}>📥 Download PDF</Text></TouchableOpacity>
            </View>
          );
        })}
        {invoices.length === 0 && <Text style={s.empty}>No invoices yet</Text>}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#F5F5F5" },
  header: { backgroundColor: "#fff", paddingTop: Platform.OS === "web" ? 16 : 52, paddingBottom: 12, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: "#E2E8F0" },
  title: { fontSize: 18, fontWeight: "900", color: "#0F172A" },
  monthPill: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20, backgroundColor: "#F1F5F9", borderWidth: 1.5, borderColor: "#E2E8F0" },
  monthActive: { backgroundColor: colors.brand, borderColor: colors.brand },
  monthText: { fontSize: 11, fontWeight: "700", color: "#64748B" },
  // Summary card
  summaryCard: { backgroundColor: "#fff", borderRadius: 16, padding: 16, marginBottom: 14, borderWidth: 1, borderColor: "#E2E8F0" },
  summaryLabel: { fontSize: 11, fontWeight: "600", color: "#94A3B8", marginBottom: 12 },
  summaryRow: { flexDirection: "row", justifyContent: "space-between", marginBottom: 14 },
  summaryItem: { alignItems: "center", flex: 1 },
  summaryVal: { fontSize: 16, fontWeight: "900", color: "#0F172A" },
  summaryLbl: { fontSize: 9, fontWeight: "600", color: "#94A3B8", marginTop: 3 },
  downloadAll: { backgroundColor: "#E8EEFB", borderRadius: 10, paddingVertical: 10, alignItems: "center" },
  downloadAllText: { fontSize: 12, fontWeight: "700", color: colors.brand },
  // Invoice cards
  invCard: { backgroundColor: "#fff", borderRadius: 14, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: "#E2E8F0" },
  invTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  invLeft: { flexDirection: "row", gap: 10, flex: 1 },
  invIconWrap: { width: 36, height: 36, borderRadius: 10, backgroundColor: "#F8FAFC", alignItems: "center", justifyContent: "center" },
  invNum: { fontSize: 12, fontWeight: "800", color: "#0F172A" },
  invMeta: { fontSize: 9, color: "#94A3B8", fontWeight: "500", marginTop: 2 },
  invRight: { alignItems: "flex-end" },
  invAmt: { fontSize: 14, fontWeight: "900", color: "#0F172A" },
  invGst: { fontSize: 9, color: "#D97706", fontWeight: "600", marginTop: 2 },
  dlBtn: { backgroundColor: "#F1F5F9", borderRadius: 8, paddingVertical: 7, alignItems: "center", marginTop: 10 },
  dlBtnText: { fontSize: 11, fontWeight: "700", color: colors.brand },
  empty: { textAlign: "center", color: "#94A3B8", fontSize: 13, paddingTop: 40 },
});
