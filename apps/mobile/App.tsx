import React, { useEffect, useState, useCallback } from "react";
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useAuthStore } from "./src/store/auth";
import { colors, fonts, fontSize, shadows } from "./src/lib/theme";
import { useAppFonts } from "./src/lib/fonts";

import SplashScreen from "./src/screens/SplashScreen";
import LoginScreen from "./src/screens/LoginScreen";
import HomeScreen from "./src/screens/HomeScreen";
import IndentScreen from "./src/screens/IndentScreen";
import CategoriesScreen from "./src/screens/CategoriesScreen";
import OrdersScreen from "./src/screens/OrdersScreen";
import CartScreen from "./src/screens/CartScreen";
import OrderConfirmedScreen from "./src/screens/OrderConfirmedScreen";
import InvoicesScreen from "./src/screens/InvoicesScreen";
import ProfileScreen from "./src/screens/ProfileScreen";
import NotificationsScreen from "./src/screens/NotificationsScreen";
import ManageStandingIndentScreen from "./src/screens/ManageStandingIndentScreen";

/**
 * App.tsx — v2 navigation shell.
 *
 * Tabs (bottom): Home · Indent · Orders · Categories
 *
 * Pushed screens (full-screen, no tab bar):
 *   • splash, login        — auth flow
 *   • cart, confirmed      — checkout flow
 *   • profile              — reachable via avatar in AppHeader
 *   • invoices             — reachable from Orders or Profile
 *   • notifications        — reachable via bell in AppHeader
 *
 * Why Profile is pushed not tabbed:
 *   The Categories tab needs a slot in the bottom bar, and Profile
 *   actions (credit top-up, settings, logout) are infrequent enough
 *   that one extra tap from the avatar is fine. The avatar lives in
 *   every tab's AppHeader, so Profile is always one tap away.
 */

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30000 } },
});

type Tab = "home" | "indent" | "orders" | "categories";
type PushedScreen =
  | "splash"
  | "login"
  | "tabs"
  | "cart"
  | "confirmed"
  | "profile"
  | "invoices"
  | "notifications"
  | "manage-standing";

function AppContent() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const isLoading = useAuthStore((s) => s.isLoading);
  const initialize = useAuthStore((s) => s.initialize);

  const [screen, setScreen] = useState<PushedScreen>("splash");
  const [activeTab, setActiveTab] = useState<Tab>("home");
  const [confirmedOrderId, setConfirmedOrderId] = useState("");

  useEffect(() => {
    initialize();
  }, []);

  useEffect(() => {
    if (isLoading) return;
    if (isAuthenticated && (screen === "splash" || screen === "login")) {
      setScreen("tabs");
      setActiveTab("home");
    } else if (!isAuthenticated && screen !== "splash" && screen !== "login") {
      setScreen("splash");
    }
  }, [isAuthenticated, isLoading]);

  const handleLoginSuccess = useCallback(() => {
    setScreen("tabs");
    setActiveTab("home");
  }, []);

  const goToTabs = useCallback(() => setScreen("tabs"), []);

  // Common header handlers — every tab uses these via AppHeader.
  const handleOpenNotifications = useCallback(() => {
    setScreen("notifications");
  }, []);
  const handleOpenProfile = useCallback(() => {
    setScreen("profile");
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

  // ── Auth flow ──
  if (!isAuthenticated || screen === "splash") {
    if (screen === "login") {
      return (
        <LoginScreen
          onBack={() => setScreen("splash")}
          onSuccess={handleLoginSuccess}
        />
      );
    }
    return <SplashScreen onLogin={() => setScreen("login")} />;
  }

  // ── Pushed screens (full-screen, no tab bar) ──
  if (screen === "cart") {
    return (
      <CartScreen
        onBack={goToTabs}
        onOrderPlaced={(id) => {
          setConfirmedOrderId(id);
          setScreen("confirmed");
        }}
      />
    );
  }

  if (screen === "confirmed") {
    return (
      <OrderConfirmedScreen
        orderId={confirmedOrderId}
        onGoHome={() => {
          setScreen("tabs");
          setActiveTab("home");
        }}
      />
    );
  }

  if (screen === "notifications") {
    return <NotificationsScreen onBack={goToTabs} />;
  }

  if (screen === "profile") {
    return <ProfileScreen onBack={goToTabs} />;
  }

  if (screen === "invoices") {
    return <InvoicesScreen onBack={goToTabs} />;
  }

  if (screen === "manage-standing") {
    return <ManageStandingIndentScreen onBack={goToTabs} />;
  }

  // ── Tabbed shell ──
  return (
    <View style={styles.main}>
      <View style={styles.screenArea}>
        {activeTab === "home" && (
          <HomeScreen
            onOpenIndent={() => setScreen("cart")}
            onOpenIndentForDate={() => setActiveTab("indent")}
            onOpenNotifications={handleOpenNotifications}
            onOpenProfile={handleOpenProfile}
          />
        )}
        {activeTab === "indent" && (
          <IndentScreen
            onOpenNotifications={handleOpenNotifications}
            onOpenProfile={handleOpenProfile}
            onOpenManageStanding={() => setScreen("manage-standing")}
          />
        )}
        {activeTab === "orders" && (
          <OrdersScreen
            onOpenNotifications={handleOpenNotifications}
            onOpenProfile={handleOpenProfile}
            onOpenInvoices={() => setScreen("invoices")}
          />
        )}
        {activeTab === "categories" && (
          <CategoriesScreen
            onOpenIndent={() => setScreen("cart")}
            onOpenIndentForDate={() => setActiveTab("indent")}
            onOpenNotifications={handleOpenNotifications}
            onOpenProfile={handleOpenProfile}
          />
        )}
      </View>

      <View style={styles.tabBar}>
        {(
          [
            { key: "home" as Tab, icon: "🏠", label: "Home" },
            { key: "indent" as Tab, icon: "📋", label: "Indent" },
            { key: "orders" as Tab, icon: "🧾", label: "Orders" },
            { key: "categories" as Tab, icon: "🗂️", label: "Categories" },
          ]
        ).map((tab) => (
          <TouchableOpacity
            key={tab.key}
            style={styles.tab}
            onPress={() => {
              setActiveTab(tab.key);
              setScreen("tabs");
            }}
            activeOpacity={0.7}
          >
            <Text
              style={[
                styles.tabIcon,
                activeTab === tab.key && styles.tabIconActive,
              ]}
            >
              {tab.icon}
            </Text>
            <Text
              style={[
                styles.tabLabel,
                activeTab === tab.key && styles.tabLabelActive,
              ]}
            >
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
        <StatusBar style="dark" />
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

  main: { flex: 1, backgroundColor: colors.background },
  screenArea: { flex: 1 },

  tabBar: {
    flexDirection: "row",
    backgroundColor: colors.card,
    borderTopWidth: 0.5,
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
  tabIcon: { fontSize: 22, opacity: 0.5 },
  tabIconActive: { opacity: 1 },
  tabLabel: {
    fontSize: 11,
    fontFamily: fonts.bold,
    color: colors.mutedForeground,
    letterSpacing: 0.3,
  },
  tabLabelActive: { color: colors.primary },
});