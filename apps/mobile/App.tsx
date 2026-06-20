import React, { useEffect, useState, useCallback } from "react";
import {
  ActivityIndicator,
  AppState,
  type AppStateStatus,
  BackHandler,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import {
  SafeAreaProvider,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import {
  QueryClient,
  QueryClientProvider,
  QueryCache,
  MutationCache,
  focusManager,
} from "@tanstack/react-query";
import { useAuthStore } from "./src/store/auth";
import { ApiError } from "./src/lib/api";
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
import IndentCheckoutScreen from "./src/screens/IndentCheckoutScreen";
import PriceChartScreen from "./src/screens/PriceChartScreen";

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
 *
 * WHAT CHANGED IN THIS REVISION
 *   1. Android hardware/system back button is now intercepted (it used
 *      to exit the app because this state-based nav never wired up
 *      BackHandler). See the BackHandler effect in AppContent.
 *   2. The bottom tab bar now respects the system navigation inset, so
 *      3-button navigation no longer overlaps the tabs.
 *   3. React Query's focus detection is wired to AppState, so queries
 *      auto-refetch when the app returns to the foreground.
 *   4. A dead session (ApiError 401) now triggers a global forced
 *      logout instead of leaving the user stranded on a broken page.
 */

// ── React Query: wire focus detection to React Native ──────────────────
// `refetchOnWindowFocus` is a browser-only feature by default — there is
// no `window` focus event in React Native. Bridging focusManager to
// AppState makes "refetch when the app is foregrounded" actually work.
focusManager.setEventListener((handleFocus) => {
  const sub = AppState.addEventListener("change", (status: AppStateStatus) => {
    handleFocus(status === "active");
  });
  return () => sub.remove();
});

// A truly dead session (access token expired AND refresh failed) surfaces
// as ApiError 401 thrown from api.ts. Catch it globally so the app forces
// a logout — App.tsx's auth effect then routes back to the splash screen
// instead of sitting on a logged-in page that errors on every fetch.
function handleGlobalAuthError(error: unknown) {
  if (error instanceof ApiError && error.status === 401) {
    useAuthStore.getState().forceLogout();
  }
}

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: handleGlobalAuthError }),
  mutationCache: new MutationCache({ onError: handleGlobalAuthError }),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      // Works now because focusManager is bridged to AppState above.
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      // Never retry a 401 — the session is gone; retrying only delays
      // the forced logout. Other errors still get one retry.
      retry: (failureCount, error) => {
        if (error instanceof ApiError && error.status === 401) return false;
        return failureCount < 1;
      },
    },
  },
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
  | "manage-standing"
  | "indent-checkout"
  | "price-chart";

function AppContent() {
  const insets = useSafeAreaInsets();

  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const isLoading = useAuthStore((s) => s.isLoading);
  const initialize = useAuthStore((s) => s.initialize);
  const dealer = useAuthStore((s) => s.dealer);
  const refreshProfile = useAuthStore((s) => s.refreshProfile);

  const [screen, setScreen] = useState<PushedScreen>("splash");
  const [activeTab, setActiveTab] = useState<Tab>("home");
  const [confirmedOrderId, setConfirmedOrderId] = useState("");

  useEffect(() => {
    initialize();
  }, []);

  // If initialize() swallowed a transient error (timeout / network blip),
  // isAuthenticated can be true (from persisted state) but dealer is null.
  // Re-fetch the profile silently so AppHeader doesn't stay blank.
  useEffect(() => {
    if (isAuthenticated && !dealer) refreshProfile();
  }, [isAuthenticated, dealer]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (isLoading) return;
    if (isAuthenticated && (screen === "splash" || screen === "login")) {
      setScreen("tabs");
      setActiveTab("home");
    } else if (!isAuthenticated && screen !== "splash" && screen !== "login") {
      setScreen("splash");
    }
  }, [isAuthenticated, isLoading]);

  // ── Android hardware / system back button ──────────────────────────
  // This state-based navigation never registered a BackHandler, so the
  // OS treated every back press as "exit the app". Now we map the press
  // to the same logical "go back" the on-screen back buttons perform.
  //
  // Returning `true`  = "we handled it, don't exit".
  // Returning `false` = "we didn't handle it, let the OS exit/background".
  useEffect(() => {
    const onBackPress = (): boolean => {
      // Auth flow — login returns to splash; splash lets the OS exit.
      if (!isAuthenticated || screen === "splash") {
        if (screen === "login") {
          setScreen("splash");
          return true;
        }
        return false;
      }

      // Any pushed full-screen → return to the tab shell.
      if (screen !== "tabs") {
        const wasConfirmed = screen === "confirmed";
        setScreen("tabs");
        if (wasConfirmed) setActiveTab("home");
        return true;
      }

      // On the tab shell but not Home → go to Home first.
      if (activeTab !== "home") {
        setActiveTab("home");
        return true;
      }

      // Home tab at the root → allow the OS to background/exit the app.
      return false;
    };

    const sub = BackHandler.addEventListener("hardwareBackPress", onBackPress);
    return () => sub.remove();
  }, [isAuthenticated, screen, activeTab]);

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
  const handleOpenPriceChart = useCallback(() => {
    setScreen("price-chart");
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

  if (screen === "price-chart") {
    return <PriceChartScreen onBack={goToTabs} />;
  }

  if (screen === "invoices") {
    return <InvoicesScreen onBack={goToTabs} />;
  }

  if (screen === "manage-standing") {
    return <ManageStandingIndentScreen onBack={goToTabs} />;
  }

  if (screen === "indent-checkout") {
    return (
      <IndentCheckoutScreen
        onBack={() => {
          setScreen("tabs");
          setActiveTab("indent");
        }}
        onConfirmed={() => {
          setScreen("tabs");
          setActiveTab("indent");
        }}
      />
    );
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
            onOpenPriceChart={handleOpenPriceChart}
          />
        )}
        {activeTab === "indent" && (
          <IndentScreen
            onOpenNotifications={handleOpenNotifications}
            onOpenProfile={handleOpenProfile}
            onOpenPriceChart={handleOpenPriceChart}
            onOpenManageStanding={() => setScreen("manage-standing")}
            onOpenCheckout={() => setScreen("indent-checkout")}
          />
        )}
        {activeTab === "orders" && (
          <OrdersScreen
            onOpenNotifications={handleOpenNotifications}
            onOpenProfile={handleOpenProfile}
            onOpenPriceChart={handleOpenPriceChart}
            onOpenInvoices={() => setScreen("invoices")}
          />
        )}
        {activeTab === "categories" && (
          <CategoriesScreen
            onOpenIndent={() => setScreen("cart")}
            onOpenIndentForDate={() => setActiveTab("indent")}
            onOpenNotifications={handleOpenNotifications}
            onOpenProfile={handleOpenProfile}
            onOpenPriceChart={handleOpenPriceChart}
          />
        )}
      </View>

      {/* Bottom tab bar — paddingBottom respects the system navigation
          inset. With gesture nav insets.bottom is small (~16-24dp); with
          3-button nav it is ~48dp. Math.max keeps a 14dp minimum so the
          tabs never sit flush against the bezel and never overlap the
          system buttons. */}
      <View
        style={[styles.tabBar, { paddingBottom: Math.max(insets.bottom, 14) }]}
      >
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
    // paddingBottom is applied inline from the safe-area inset — do NOT
    // hardcode it here, or 3-button navigation overlaps the tabs.
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