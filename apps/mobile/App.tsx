import React, { useEffect, useState, useCallback } from "react";
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useAuthStore } from "./src/store/auth";
import { colors, fonts, fontSize, shadows } from "./src/lib/theme";
import { useAppFonts } from "./src/lib/fonts";

import SplashScreen from "./src/screens/SplashScreen";
import LoginScreen from "./src/screens/LoginScreen";
import HomeScreen from "./src/screens/HomeScreen";
import CartScreen from "./src/screens/CartScreen";
import OrderConfirmedScreen from "./src/screens/OrderConfirmedScreen";
import OrdersScreen from "./src/screens/OrdersScreen";
import InvoicesScreen from "./src/screens/InvoicesScreen";
import ProfileScreen from "./src/screens/ProfileScreen";
import NotificationsScreen from "./src/screens/NotificationsScreen";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30000 } },
});

type Screen = "splash" | "login" | "home" | "cart" | "confirmed" | "notifications";
type Tab = "home" | "orders" | "invoices" | "profile";

function AppContent() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const isLoading = useAuthStore((s) => s.isLoading);
  const initialize = useAuthStore((s) => s.initialize);

  const [screen, setScreen] = useState<Screen>("splash");
  const [activeTab, setActiveTab] = useState<Tab>("home");
  const [confirmedOrderId, setConfirmedOrderId] = useState("");

  useEffect(() => { initialize(); }, []);

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
    setScreen("home");
    setActiveTab("home");
  }, []);

  // ── Loading (auth hydration) ──
  if (isLoading) {
    return (
      <View style={styles.loading}>
        <Text style={styles.loadingEmoji}>🐄</Text>
        <Text style={styles.loadingText}>Loading…</Text>
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

  // Notifications screen branch
  if (screen === "notifications") {
    return <NotificationsScreen onBack={() => setScreen("home")} />;
  }

  // ── Main app with tabs ──
  return (
    <View style={styles.main}>
      <View style={styles.screenArea}>
        {activeTab === "home" && 
          <HomeScreen 
            onOpenCart={() => setScreen("cart")} 
            onOpenNotifications={() => setScreen("notifications")}
          />}
        {activeTab === "orders" && <OrdersScreen />}
        {activeTab === "invoices" && <InvoicesScreen />}
        {activeTab === "profile" && <ProfileScreen />}
      </View>

      <View style={styles.tabBar}>
        {([
          { key: "home" as Tab,     icon: "🏠", label: "Home" },
          { key: "orders" as Tab,   icon: "📋", label: "Orders" },
          { key: "invoices" as Tab, icon: "🧾", label: "Invoices" },
          { key: "profile" as Tab,  icon: "👤", label: "Profile" },
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
  const fontsReady = useAppFonts();

  // Fonts must load before we render anything that uses `font-family`
  // (which is nearly everything once Phase 2 components land).
  if (!fontsReady) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <StatusBar style="light" />
        <AppContent />
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.background,
  },
  loadingEmoji: { fontSize: 40, marginBottom: 8 },
  loadingText: {
    fontFamily: fonts.semibold,
    color: colors.mutedForeground,
    fontSize: fontSize.base,
  },

  main:       { flex: 1, backgroundColor: colors.background },
  screenArea: { flex: 1 },

  tabBar: {
    flexDirection: "row",
    backgroundColor: colors.card,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: 7,
    paddingBottom: 14,
    ...shadows.bottomNav,
  },
  tab: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
    minHeight: 44,
  },
  tabIcon:       { fontSize: 22, opacity: 0.55 },
  tabIconActive: { opacity: 1 },
  tabLabel: {
    fontSize: 9,
    fontFamily: fonts.bold,
    color: colors.mutedForeground,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  tabLabelActive: { color: colors.primary },
});
