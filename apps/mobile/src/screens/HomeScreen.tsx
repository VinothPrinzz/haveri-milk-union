import React, { useState, useEffect, useCallback } from "react";
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, RefreshControl, StatusBar, Platform } from "react-native";
import { colors } from "../lib/theme";
import { formatCurrency } from "../lib/utils";
import { useAuthStore } from "../store/auth";
import { useCartStore } from "../store/cart";
import ProductCard from "../components/ProductCard";
import StickyCart from "../components/StickyCart";
import { api } from "../lib/api";

interface Props { onOpenCart: () => void; }

export default function HomeScreen({ onOpenCart }: Props) {
  const dealer = useAuthStore((s) => s.dealer);
  const [windowState, setWindowState] = useState<"open"|"warning"|"closed">("closed");
  const [windowInfo, setWindowInfo] = useState<any>(null);
  const [products, setProducts] = useState<any[]>([]);
  const [categories, setCategories] = useState<any[]>([]);
  const [banners, setBanners] = useState<any[]>([]);
  const [recentOrders, setRecentOrders] = useState<any[]>([]);
  const [selectedCat, setSelectedCat] = useState("All");
  const [refreshing, setRefreshing] = useState(false);
  const [timeLeft, setTimeLeft] = useState("");
  const addItem = useCartStore((s) => s.addItem);

  const fetchData = useCallback(async () => {
    const [winRes, prodRes, catRes, bannerRes, orderRes] = await Promise.all([
      api.get("/api/v1/window/status").catch(() => ({ windows: [] })),
      api.get("/api/v1/products").catch(() => ({ products: [] })),
      api.get("/api/v1/categories").catch(() => ({ categories: [] })),
      api.get("/api/v1/banners").catch(() => ({ banners: [] })),
      api.get("/api/v1/orders/my", { page: 1, limit: 5 }).catch(() => ({ data: [] })),
    ]);
    const win = winRes.windows?.[0] ?? winRes;
    setWindowState(win.state ?? "closed");
    setWindowInfo(win);
    setProducts(prodRes.products ?? prodRes.data ?? []);
    setCategories([{ id: "all", name: "All", icon: "🏷️" }, ...(catRes.categories ?? [])]);
    setBanners(bannerRes.banners ?? []);
    setRecentOrders((orderRes.data ?? []).filter((o: any) => o.status === "delivered" || o.status === "confirmed").slice(0, 5));
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);
  useEffect(() => { const i = setInterval(fetchData, 30000); return () => clearInterval(i); }, [fetchData]);

  // Countdown timer
  useEffect(() => {
    if (windowState === "closed" || !windowInfo?.closeTime) return;
    const timer = setInterval(() => {
      const now = new Date();
      const [h, m] = (windowInfo.closeTime as string).split(":").map(Number);
      const close = new Date(); close.setHours(h!, m!, 0, 0);
      const diff = close.getTime() - now.getTime();
      if (diff <= 0) { setTimeLeft("00:00"); setWindowState("closed"); return; }
      setTimeLeft(`${String(Math.floor(diff/60000)).padStart(2,"0")}:${String(Math.floor((diff%60000)/1000)).padStart(2,"0")}`);
    }, 1000);
    return () => clearInterval(timer);
  }, [windowState, windowInfo]);

  const onRefresh = async () => { setRefreshing(true); await fetchData(); setRefreshing(false); };
  const filtered = selectedCat === "All" ? products : products.filter((p: any) => (p.categoryName || p.category_name) === selectedCat);

  const headerBg = windowState === "open" ? "#1448CC" : windowState === "warning" ? "#92400E" : "#1E293B";

  return (
    <View style={s.root}>
      <StatusBar barStyle="light-content" />
      <ScrollView refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />} contentContainerStyle={{ paddingBottom: 90 }}>
        {/* ── HEADER ── */}
        <View style={[s.header, { backgroundColor: headerBg }]}>  
          <View style={s.hdrRow}>
            <View><Text style={s.greeting}>Good morning,</Text><Text style={s.name}>{dealer?.name ?? "Dealer"} 🏪</Text></View>
            <View style={s.hdrRight}><Text style={{ fontSize: 20 }}>🔔</Text><Text style={{ fontSize: 20 }}>👤</Text></View>
          </View>
          <View style={s.locChip}><Text style={{ fontSize: 11 }}>📍</Text><Text style={s.locText}>{dealer?.locationLabel || dealer?.zoneName || "Your Location"}</Text><Text style={{ fontSize: 8, color: "rgba(255,255,255,0.5)" }}>▾</Text></View>

          {/* Window Banner */}
          {windowState === "open" && (
            <View style={s.winBanner}><View style={[s.dot, { backgroundColor: "#4ADE80" }]} /><View style={{ flex: 1 }}><Text style={s.winLabel}>🟢 Window Open</Text><Text style={s.winSub}>Order now · Closes at {windowInfo?.closeTime ?? "8:00 AM"}</Text></View><View style={s.timerBox}><Text style={s.timerVal}>{timeLeft||"--:--"}</Text><Text style={s.timerSub}>LEFT</Text></View></View>
          )}
          {windowState === "warning" && (
            <View style={[s.winBanner, { backgroundColor: "rgba(255,255,255,0.15)" }]}><View style={[s.dot, { backgroundColor: "#FCD34D" }]} /><View style={{ flex: 1 }}><Text style={[s.winLabel, { opacity: 0.7 }]}>⚠️ Closing soon!</Text><Text style={s.winSub}>Order before {windowInfo?.closeTime ?? "8:00 AM"} · {timeLeft} left</Text></View><View style={[s.timerBox, { backgroundColor: "rgba(255,255,255,0.2)" }]}><Text style={s.timerVal}>{timeLeft}</Text><Text style={s.timerSub}>HURRY!</Text></View></View>
          )}
          {windowState === "closed" && (
            <View style={[s.winBanner, { backgroundColor: "rgba(255,255,255,0.08)" }]}><Text style={{ fontSize: 18 }}>🔒</Text><View style={{ flex: 1 }}><Text style={[s.winLabel, { opacity: 0.5 }]}>Window Closed</Text><Text style={s.winSub}>Opens tomorrow at {windowInfo?.openTime ?? "6:00 AM"}</Text></View></View>
          )}
        </View>

        {windowState !== "closed" ? (
          <>
            {/* ── BANNERS ── */}
            {banners.length > 0 && (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 12 }} contentContainerStyle={{ paddingHorizontal: 12, gap: 10 }}>
                {banners.map((b: any, i: number) => {
                  const bgColors = ["#1448CC", "#92400E", "#16A34A", "#9333EA"];
                  return (
                    <View key={b.id || i} style={[s.bannerCard, { backgroundColor: bgColors[i % 4] }]}>
                      <Text style={s.bannerEmoji}>{["🥛","🧈","🚚","🎉"][i%4]}</Text>
                      <View><Text style={s.bannerSub}>{b.subtitle || "Special Offer"}</Text><Text style={s.bannerTitle}>{b.title}</Text></View>
                    </View>
                  );
                })}
              </ScrollView>
            )}

            {/* ── ORDER AGAIN ── */}
            {recentOrders.length > 0 && (
              <>
                <View style={s.secHdr}><Text style={s.secTitle}>🔄 Order Again</Text><Text style={s.secLink}>View All</Text></View>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 12, gap: 9 }}>
                  {recentOrders.map((o: any) => (
                    <TouchableOpacity key={o.id} style={s.reorderCard}>
                      <Text style={{ fontSize: 22, textAlign: "center" }}>{(o.items?.[0]?.product_name || "").includes("Milk") ? "🥛" : "📦"}</Text>
                      <Text style={s.rcName} numberOfLines={2}>{o.items?.[0]?.product_name || "Order"}</Text>
                      <Text style={s.rcQty}>×{o.items?.[0]?.quantity || o.item_count}</Text>
                      <View style={s.rcAdd}><Text style={{ fontSize: 11, fontWeight: "900", color: "#fff" }}>+</Text></View>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              </>
            )}

            {/* ── CATEGORIES ── */}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 12 }} contentContainerStyle={{ paddingHorizontal: 12, gap: 7 }}>
              {categories.map((c: any) => (
                <TouchableOpacity key={c.id} style={[s.catPill, selectedCat === c.name && s.catActive]} onPress={() => setSelectedCat(c.name)}>
                  <Text style={{ fontSize: 13 }}>{c.icon}</Text>
                  <Text style={[s.catText, selectedCat === c.name && { color: "#fff" }]}>{c.name}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>

            {/* ── PRODUCTS ── */}
            <View style={s.secHdr}><Text style={s.secTitle}>All Products</Text></View>
            <View style={s.grid}>
              {filtered.map((p: any) => <ProductCard key={p.id} product={p} />)}
              {filtered.length === 0 && <Text style={{ textAlign: "center", color: colors.mutedFg, padding: 30, width: "100%" }}>No products available</Text>}
            </View>
          </>
        ) : (
          /* ── CLOSED STATE ── */
          <View style={{ padding: 14, gap: 10 }}>
            <View style={s.closedCard}><Text style={s.closedTitle}>📊 Today's Summary</Text><Text style={s.closedText}>Orders placed: {recentOrders.length}</Text><Text style={s.closedText}>Wallet: {formatCurrency(dealer?.walletBalance ?? 0)}</Text></View>
            {recentOrders.length > 0 && (
              <View style={s.closedCard}><Text style={s.closedTitle}>📦 Yesterday's Order</Text>
                {recentOrders.slice(0, 1).map((o: any) => <Text key={o.id} style={s.closedText}>{o.item_count} items · {formatCurrency(o.grand_total)}</Text>)}
              </View>
            )}
            <View style={[s.closedCard, { backgroundColor: "#E8EEFB", borderColor: "#C8D6F4" }]}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                <Text style={{ fontSize: 20 }}>🔔</Text>
                <View style={{ flex: 1 }}><Text style={{ fontSize: 11, fontWeight: "800", color: colors.brand }}>Get notified at 5:55 AM</Text><Text style={{ fontSize: 9, color: colors.mutedFg, marginTop: 2 }}>We'll remind you 5 min before window opens</Text></View>
                <View style={{ width: 35, height: 20, backgroundColor: colors.brand, borderRadius: 999 }}><View style={{ position: "absolute", width: 16, height: 16, backgroundColor: "#fff", borderRadius: 8, top: 2, right: 2 }} /></View>
              </View>
            </View>
          </View>
        )}
      </ScrollView>

      {windowState !== "closed" && <StickyCart onPress={onOpenCart} variant={windowState === "warning" ? "warning" : "open"} />}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#F5F5F5" },
  header: { paddingTop: Platform.OS === "web" ? 24 : 48, paddingBottom: 14, paddingHorizontal: 14, borderBottomLeftRadius: 20, borderBottomRightRadius: 20 },
  hdrRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 },
  greeting: { fontSize: 10, color: "rgba(255,255,255,0.6)", fontWeight: "600" },
  name: { fontSize: 16, fontWeight: "900", color: "#fff", marginTop: 2 },
  hdrRight: { flexDirection: "row", gap: 10, marginTop: 4 },
  locChip: { flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: "rgba(255,255,255,0.15)", borderRadius: 20, paddingHorizontal: 10, paddingVertical: 5, alignSelf: "flex-start", marginBottom: 10 },
  locText: { fontSize: 10, fontWeight: "600", color: "rgba(255,255,255,0.9)" },
  winBanner: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: "rgba(255,255,255,0.12)", borderRadius: 14, padding: 11 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  winLabel: { fontSize: 10, fontWeight: "800", color: "rgba(255,255,255,0.9)" },
  winSub: { fontSize: 9, fontWeight: "600", color: "rgba(255,255,255,0.6)", marginTop: 1 },
  timerBox: { backgroundColor: "rgba(255,255,255,0.15)", borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4, alignItems: "center" },
  timerVal: { fontSize: 14, fontWeight: "900", color: "#fff", fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
  timerSub: { fontSize: 7, fontWeight: "700", color: "rgba(255,255,255,0.5)" },
  // Banners
  bannerCard: { width: 220, borderRadius: 14, padding: 14, flexDirection: "row", alignItems: "center", gap: 10 },
  bannerEmoji: { fontSize: 30 },
  bannerSub: { fontSize: 9, color: "rgba(255,255,255,0.6)", fontWeight: "600" },
  bannerTitle: { fontSize: 11, color: "#fff", fontWeight: "800", lineHeight: 15, marginTop: 2 },
  // Section headers
  secHdr: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 14, paddingTop: 14, paddingBottom: 6 },
  secTitle: { fontSize: 13, fontWeight: "800", color: "#0F172A" },
  secLink: { fontSize: 10, fontWeight: "700", color: colors.brand },
  // Order Again
  reorderCard: { width: 80, backgroundColor: "#fff", borderWidth: 1.5, borderColor: "#E2E8F0", borderRadius: 14, padding: 8, alignItems: "center" },
  rcName: { fontSize: 8, fontWeight: "700", color: "#64748B", textAlign: "center", lineHeight: 11, marginTop: 3 },
  rcQty: { fontSize: 8, color: "#94A3B8", fontWeight: "600", marginTop: 2 },
  rcAdd: { position: "absolute", bottom: -1, right: -1, width: 20, height: 20, backgroundColor: colors.brand, borderTopLeftRadius: 5, borderBottomRightRadius: 14, alignItems: "center", justifyContent: "center" },
  // Categories
  catPill: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, backgroundColor: "#fff", borderWidth: 1.5, borderColor: "#E2E8F0" },
  catActive: { backgroundColor: colors.brand, borderColor: colors.brand },
  catText: { fontSize: 10, fontWeight: "700", color: "#64748B" },
  // Products
  grid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", paddingHorizontal: 12, paddingTop: 4 },
  // Closed
  closedCard: { backgroundColor: "#fff", borderRadius: 14, padding: 14, borderWidth: 1, borderColor: "#E2E8F0" },
  closedTitle: { fontSize: 12, fontWeight: "800", color: "#0F172A", marginBottom: 6 },
  closedText: { fontSize: 11, color: "#94A3B8", fontWeight: "500", lineHeight: 18 },
});
