import React, { useState, useEffect } from "react";
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, Alert, Platform } from "react-native";
import { colors } from "../lib/theme";
import { formatCurrency } from "../lib/utils";
import { useAuthStore } from "../store/auth";
import { api } from "../lib/api";

export default function ProfileScreen() {
  const dealer = useAuthStore((s) => s.dealer);
  const logout = useAuthStore((s) => s.logout);
  const [lang, setLang] = useState("EN");
  const [notifOn, setNotifOn] = useState(true);
  const [orderStats, setOrderStats] = useState({ count: 0, value: 0 });

  useEffect(() => {
    api.get("/api/v1/orders/my", { page: 1, limit: 50 }).then((d: any) => {
      const orders = d.data ?? [];
      const thisMonth = orders.filter((o: any) => {
        const d = new Date(o.created_at);
        const now = new Date();
        return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
      });
      setOrderStats({ count: thisMonth.length, value: thisMonth.reduce((a: number, o: any) => a + parseFloat(o.grand_total || 0), 0) });
    }).catch(() => {});
  }, []);

  const handleLogout = () => {
    if (Platform.OS === "web") { if (confirm("Logout?")) logout(); }
    else Alert.alert("Logout", "Are you sure?", [{ text: "Cancel" }, { text: "Logout", style: "destructive", onPress: logout }]);
  };

  return (
    <View style={s.root}>
      {/* Header */}
      <View style={s.header}>
        {/* Agency Card */}
        <View style={s.agencyCard}>
          <View style={s.avatar}><Text style={{ fontSize: 28 }}>🏪</Text></View>
          <View style={{ flex: 1 }}>
            <Text style={s.agencyName}>{dealer?.name ?? "Dealer"}</Text>
            <Text style={s.agencyId}>ID: HMU-AG-{dealer?.id?.slice(0, 8)} · {dealer?.locationLabel || dealer?.zoneName}</Text>
            <View style={s.verifiedBadge}><Text style={s.verifiedText}>✓ Verified Dealer</Text></View>
          </View>
        </View>

        {/* Stats Row */}
        <View style={s.statsRow}>
          <View style={s.stat}><Text style={s.statVal}>{orderStats.count}</Text><Text style={s.statLbl}>Orders {new Date().toLocaleString("en-IN", { month: "short" })}</Text></View>
          <View style={s.stat}><Text style={s.statVal}>{orderStats.value >= 100000 ? `₹${(orderStats.value / 100000).toFixed(1)}L` : formatCurrency(orderStats.value)}</Text><Text style={s.statLbl}>{new Date().toLocaleString("en-IN", { month: "short" })} Value</Text></View>
          <View style={s.stat}><Text style={s.statVal}>1yr</Text><Text style={s.statLbl}>Member</Text></View>
        </View>
      </View>

      <ScrollView style={{ flex: 1, padding: 14 }}>
        {/* Account Group */}
        <View style={s.group}>
          <SettingItem icon="📍" iconBg="#E8EEFB" title="Delivery Zone" sub={`${dealer?.locationLabel || dealer?.zoneName || "—"} · Zone A01`} />
          <SettingItem icon="📱" iconBg="#E8EEFB" title="Mobile Number" sub={`+91 ${dealer?.phone || "—"} · Verified`} />
          <SettingItem icon="🏢" iconBg="#FEF3C7" title="GST Number" sub="29AAXXX1234K1Z5" />
        </View>

        {/* Preferences Group */}
        <View style={s.group}>
          <View style={s.settingRow}>
            <View style={[s.iconWrap, { backgroundColor: "#F1F5F9" }]}><Text style={{ fontSize: 16 }}>🌐</Text></View>
            <View style={{ flex: 1 }}><Text style={s.settingTitle}>Language</Text></View>
            <View style={s.langToggle}>
              <TouchableOpacity style={[s.langBtn, lang === "EN" && s.langActive]} onPress={() => setLang("EN")}><Text style={[s.langText, lang === "EN" && { color: "#fff" }]}>EN</Text></TouchableOpacity>
              <TouchableOpacity style={[s.langBtn, lang === "KN" && s.langActive]} onPress={() => setLang("KN")}><Text style={[s.langText, lang === "KN" && { color: "#fff" }]}>ಕನ್ನಡ</Text></TouchableOpacity>
            </View>
          </View>
          <View style={s.settingRow}>
            <View style={[s.iconWrap, { backgroundColor: "#F1F5F9" }]}><Text style={{ fontSize: 16 }}>🔔</Text></View>
            <View style={{ flex: 1 }}><Text style={s.settingTitle}>Push Notifications</Text><Text style={s.settingSub}>Window reminders & order updates</Text></View>
            <TouchableOpacity onPress={() => setNotifOn(!notifOn)} style={[s.toggle, notifOn && s.toggleOn]}><View style={[s.toggleKnob, notifOn && s.toggleKnobOn]} /></TouchableOpacity>
          </View>
        </View>

        {/* Wallet Group */}
        <View style={s.group}>
          <View style={s.settingRow}>
            <View style={[s.iconWrap, { backgroundColor: "#DCFCE7" }]}><Text style={{ fontSize: 16 }}>💰</Text></View>
            <View style={{ flex: 1 }}><Text style={s.settingTitle}>Wallet Balance</Text><Text style={s.settingSub}>Available for orders</Text></View>
            <Text style={{ fontSize: 16, fontWeight: "900", color: "#16A34A" }}>{formatCurrency(dealer?.walletBalance ?? 0)}</Text>
          </View>
        </View>

        {/* Support Group */}
        <View style={s.group}>
          <SettingItem icon="📞" iconBg="#F1F5F9" title="Support & Help" sub="Contact Haveri Milk Union" />
          <SettingItem icon="ℹ️" iconBg="#F1F5F9" title="About" sub="v1.0.0 · Haveri Milk Union" />
        </View>

        {/* Logout */}
        <TouchableOpacity style={s.logoutBtn} onPress={handleLogout}>
          <Text style={s.logoutText}>🚪 Logout</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

function SettingItem({ icon, iconBg, title, sub }: { icon: string; iconBg: string; title: string; sub: string }) {
  return (
    <TouchableOpacity style={s.settingRow}>
      <View style={[s.iconWrap, { backgroundColor: iconBg }]}><Text style={{ fontSize: 16 }}>{icon}</Text></View>
      <View style={{ flex: 1 }}><Text style={s.settingTitle}>{title}</Text><Text style={s.settingSub}>{sub}</Text></View>
      <Text style={s.arrow}>›</Text>
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#F5F5F5" },
  header: { backgroundColor: colors.brand, paddingTop: Platform.OS === "web" ? 20 : 48, paddingBottom: 16, paddingHorizontal: 14, borderBottomLeftRadius: 24, borderBottomRightRadius: 24 },
  agencyCard: { flexDirection: "row", alignItems: "center", gap: 12 },
  avatar: { width: 52, height: 52, borderRadius: 14, backgroundColor: "rgba(255,255,255,0.2)", alignItems: "center", justifyContent: "center" },
  agencyName: { fontSize: 16, fontWeight: "900", color: "#fff" },
  agencyId: { fontSize: 9, color: "rgba(255,255,255,0.6)", fontWeight: "600", marginTop: 2 },
  verifiedBadge: { backgroundColor: "rgba(22,163,74,0.2)", borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2, alignSelf: "flex-start", marginTop: 4 },
  verifiedText: { fontSize: 9, fontWeight: "800", color: "#4ADE80" },
  statsRow: { flexDirection: "row", marginTop: 14, gap: 8 },
  stat: { flex: 1, backgroundColor: "rgba(255,255,255,0.12)", borderRadius: 12, paddingVertical: 10, alignItems: "center" },
  statVal: { fontSize: 16, fontWeight: "900", color: "#fff" },
  statLbl: { fontSize: 8, fontWeight: "600", color: "rgba(255,255,255,0.5)", marginTop: 2 },
  group: { backgroundColor: "#fff", borderRadius: 14, marginBottom: 12, overflow: "hidden", borderWidth: 1, borderColor: "#E2E8F0" },
  settingRow: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderBottomWidth: 0.5, borderBottomColor: "#F1F5F9" },
  iconWrap: { width: 36, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  settingTitle: { fontSize: 12, fontWeight: "700", color: "#0F172A" },
  settingSub: { fontSize: 10, color: "#94A3B8", fontWeight: "500", marginTop: 1 },
  arrow: { fontSize: 20, color: "#CBD5E1", fontWeight: "300" },
  langToggle: { flexDirection: "row", gap: 4 },
  langBtn: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, backgroundColor: "#F1F5F9" },
  langActive: { backgroundColor: colors.brand },
  langText: { fontSize: 11, fontWeight: "700", color: "#64748B" },
  toggle: { width: 42, height: 24, borderRadius: 12, backgroundColor: "#E2E8F0", justifyContent: "center", padding: 2 },
  toggleOn: { backgroundColor: colors.brand },
  toggleKnob: { width: 20, height: 20, borderRadius: 10, backgroundColor: "#fff" },
  toggleKnobOn: { alignSelf: "flex-end" },
  logoutBtn: { backgroundColor: "#FEE2E2", borderRadius: 14, height: 48, alignItems: "center", justifyContent: "center", marginTop: 4, marginBottom: 40 },
  logoutText: { fontSize: 14, fontWeight: "800", color: "#DC2626" },
});
