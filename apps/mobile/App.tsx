import React, { useEffect, useState, useCallback } from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { StatusBar } from "expo-status-bar";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useAuthStore } from "./src/store/auth";
import { colors } from "./src/lib/theme";

import SplashScreen from "./src/screens/SplashScreen";
import LoginScreen from "./src/screens/LoginScreen";
import HomeScreen from "./src/screens/HomeScreen";
import CartScreen from "./src/screens/CartScreen";
import OrderConfirmedScreen from "./src/screens/OrderConfirmedScreen";
import OrdersScreen from "./src/screens/OrdersScreen";
import InvoicesScreen from "./src/screens/InvoicesScreen";
import ProfileScreen from "./src/screens/ProfileScreen";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30000 } },
});

type Screen = "splash" | "login" | "home" | "cart" | "confirmed";
type Tab = "home" | "orders" | "invoices" | "profile";

function AppContent() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const isLoading = useAuthStore((s) => s.isLoading);
  const initialize = useAuthStore((s) => s.initialize);
  const logout = useAuthStore((s) => s.logout);

  const [screen, setScreen] = useState<Screen>("splash");
  const [activeTab, setActiveTab] = useState<Tab>("home");
  const [confirmedOrderId, setConfirmedOrderId] = useState("");

  // Initialize auth on mount
  useEffect(() => {
    initialize();
  }, []);

  // Navigate based on auth state changes
  useEffect(() => {
    if (isLoading) return;
    if (isAuthenticated && (screen === "splash" || screen === "login")) {
      setScreen("home");
      setActiveTab("home");
    } else if (!isAuthenticated && screen !== "splash" && screen !== "login") {
      setScreen("splash");
    }
  }, [isAuthenticated, isLoading]);

  const handleLoginSuccess = useCallback(() => {
    // Auth store already set isAuthenticated=true
    // but also explicitly navigate in case the effect hasn't fired yet
    setScreen("home");
    setActiveTab("home");
  }, []);

  // ── Loading ──
  if (isLoading) {
    return (
      <View style={styles.loading}>
        <Text style={styles.loadingEmoji}>🐄</Text>
        <Text style={styles.loadingText}>Loading...</Text>
      </View>
    );
  }

  // ── Auth screens ──
  if (!isAuthenticated || screen === "splash") {
    if (screen === "login") {
      return <LoginScreen onBack={() => setScreen("splash")} onSuccess={handleLoginSuccess} />;
    }
    return <SplashScreen onLogin={() => setScreen("login")} />;
  }

  // ── Cart flow ──
  if (screen === "cart") {
    return (
      <CartScreen
        onBack={() => setScreen("home")}
        onOrderPlaced={(id) => { setConfirmedOrderId(id); setScreen("confirmed"); }}
      />
    );
  }

  if (screen === "confirmed") {
    return (
      <OrderConfirmedScreen
        orderId={confirmedOrderId}
        onGoHome={() => { setScreen("home"); setActiveTab("home"); }}
      />
    );
  }

  // ── Main app with tabs ──
  return (
    <View style={styles.main}>
      <View style={styles.screenArea}>
        {activeTab === "home" && <HomeScreen onOpenCart={() => setScreen("cart")} />}
        {activeTab === "orders" && <OrdersScreen />}
        {activeTab === "invoices" && <InvoicesScreen />}
        {activeTab === "profile" && <ProfileScreen />}
      </View>

      <View style={styles.tabBar}>
        {([
          { key: "home" as Tab, icon: "🏠", label: "Home" },
          { key: "orders" as Tab, icon: "📋", label: "Orders" },
          { key: "invoices" as Tab, icon: "🧾", label: "Invoices" },
          { key: "profile" as Tab, icon: "👤", label: "Profile" },
        ]).map((tab) => (
          <TouchableOpacity
            key={tab.key}
            style={styles.tab}
            onPress={() => { setActiveTab(tab.key); setScreen("home"); }}
            activeOpacity={0.7}
          >
            <Text style={[styles.tabIcon, activeTab === tab.key && styles.tabIconActive]}>
              {tab.icon}
            </Text>
            <Text style={[styles.tabLabel, activeTab === tab.key && styles.tabLabelActive]}>
              {tab.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <StatusBar style="auto" />
      <AppContent />
    </QueryClientProvider>
  );
}

const styles = StyleSheet.create({
  loading: { flex: 1, backgroundColor: colors.brand, alignItems: "center", justifyContent: "center" },
  loadingEmoji: { fontSize: 60 },
  loadingText: { fontSize: 14, color: "rgba(255,255,255,0.7)", marginTop: 12, fontWeight: "600" },
  main: { flex: 1 },
  screenArea: { flex: 1 },
  tabBar: { flexDirection: "row", backgroundColor: "#fff", borderTopWidth: 1, borderTopColor: colors.border, paddingBottom: 20, paddingTop: 8 },
  tab: { flex: 1, alignItems: "center", gap: 2 },
  tabIcon: { fontSize: 20, opacity: 0.4 },
  tabIconActive: { opacity: 1 },
  tabLabel: { fontSize: 10, fontWeight: "600", color: colors.mutedFg },
  tabLabelActive: { color: colors.brand, fontWeight: "800" },
});
