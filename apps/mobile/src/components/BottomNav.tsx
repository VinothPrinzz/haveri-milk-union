import React from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors, fonts, shadows } from "../lib/theme";

/**
 * BottomNav — fixed tab bar at the bottom of every dealer screen.
 *
 * Exact mockup CSS (dealer-app.html lines 49-54):
 *   .bottom-nav { background: #FFFFFF; border-top: 1px solid #E5E7EB;
 *                 padding: 7px 0 14px; box-shadow: 0 -4px 20px rgba(0,0,0,0.06) }
 *   .nav-tab   { flex: 1; flex-direction: column; align-items: center; gap: 2px }
 *   .nav-tab .ni { font-size: 20px; position: relative }
 *   .nav-tab .ni .dot { top:-2px; right:-4px; 6×6 #EF4444; border: 1.5px solid white }
 *   .nav-tab .nl { font-size: 8px; font-weight: 700; color: #9CA3AF;
 *                  text-transform: uppercase; letter-spacing: 0.5px }
 *   .nav-tab.active .nl { color: #1448CC }
 *
 * Notes:
 *   • Icon opacity doesn't change in the mockup — only the label color flips.
 *   • `unreadInvoices` controls the red dot on the Invoices tab (spec §6.1).
 *   • paddingBottom respects the device safe-area-inset-bottom; 14px is the minimum
 *     from the mockup but devices with gesture bars (iPhone X+) want more.
 */

export type BottomNavTab = "home" | "orders" | "invoices" | "profile";

interface TabDef {
  key: BottomNavTab;
  icon: string;
  label: string;
  showDot?: boolean;
}

interface BottomNavProps {
  active: BottomNavTab;
  onChange: (tab: BottomNavTab) => void;
  unreadInvoices?: boolean;
}

export default function BottomNav({ active, onChange, unreadInvoices = false }: BottomNavProps) {
  const insets = useSafeAreaInsets();

  const tabs: TabDef[] = [
    { key: "home",     icon: "🏠", label: "Home" },
    { key: "orders",   icon: "📋", label: "Orders" },
    { key: "invoices", icon: "🧾", label: "Invoices", showDot: unreadInvoices },
    { key: "profile",  icon: "👤", label: "Profile" },
  ];

  return (
    <View
      style={[
        styles.root,
        {
          // Mockup is 14px; safe-area-inset-bottom on modern iOS is usually 34.
          paddingBottom: Math.max(insets.bottom, 14),
        },
      ]}
    >
      {tabs.map((tab) => {
        const isActive = active === tab.key;
        return (
          <TouchableOpacity
            key={tab.key}
            style={styles.tab}
            onPress={() => onChange(tab.key)}
            activeOpacity={0.7}
            accessibilityRole="tab"
            accessibilityState={{ selected: isActive }}
            accessibilityLabel={tab.label}
          >
            <View style={styles.iconWrap}>
              <Text style={styles.icon}>{tab.icon}</Text>
              {tab.showDot && <View style={styles.dot} />}
            </View>
            <Text style={[styles.label, isActive && styles.labelActive]}>
              {tab.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flexDirection: "row",
    backgroundColor: colors.card,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: 7,       // mockup: padding: 7px 0 14px
    ...shadows.bottomNav, // 0 -4px 20px rgba(0,0,0,0.06)
  },
  tab: {
    flex: 1,
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 2,
    minHeight: 44,
  },
  iconWrap: {
    position: "relative",
    alignItems: "center",
    justifyContent: "center",
  },
  icon: {
    fontSize: 20,        // mockup: font-size: 20px
    lineHeight: 22,
  },
  dot: {
    position: "absolute",
    top: -2,             // mockup: top: -2px; right: -4px
    right: -4,
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.destructive, // #EF4444-ish — mockup literally uses #EF4444 but destructive (#DC2626) is close; keep destructive for consistency
    borderWidth: 1.5,
    borderColor: colors.card,
  },
  label: {
    fontSize: 8,         // mockup: font-size: 8px
    fontFamily: fonts.bold,
    color: colors.ink4,  // mockup: var(--ink4) = #9CA3AF
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  labelActive: {
    color: colors.primary,
  },
});