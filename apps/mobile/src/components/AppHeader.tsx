import React from "react";
import {
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors, fonts } from "../lib/theme";
import { useAuthStore } from "../store/auth";

/**
 * AppHeader — the shared top bar used by every primary tab.
 *
 * Layout:
 *   ┌────────────────────────────────────────────────────────┐
 *   │ Title                                       🔔   [RS]  │
 *   │ Subtitle (zone · dealer code)                          │
 *   └────────────────────────────────────────────────────────┘
 *
 * • Left: title + optional subtitle (caller supplies both).
 *   By default uses the dealer name + zone — that's the shape on
 *   Home, Indent, Orders, and Categories tabs.
 *
 * • Right: notification bell (with unread dot) + circular avatar
 *   showing the dealer's initials. Both tappable; both available on
 *   every tab so the dealer never has to "get back to Home" to
 *   reach Profile or Notifications.
 *
 * Visual style:
 *   • Flat — no shadow, just a 0.5px bottom hairline.
 *   • Minimal radius on the avatar circle (well, it's a circle).
 *   • Sits below the safe-area top inset (status bar / notch).
 */

interface AppHeaderProps {
  /** Optional override; defaults to dealer.name */
  title?: string;
  /** Optional override; defaults to "{zoneName} · {code}" */
  subtitle?: string;
  /** Whether the bell should show its unread red dot */
  unreadNotifications?: boolean;
  onBellPress: () => void;
  onProfilePress: () => void;
  /** Opens the product price chart. When omitted, the chart button is hidden. */
  onPriceChartPress?: () => void;
}

function initialsFromName(name?: string): string {
  if (!name) return "—";
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() ?? "").join("") || "—";
}

export default function AppHeader({
  title,
  subtitle,
  unreadNotifications = false,
  onBellPress,
  onProfilePress,
  onPriceChartPress,
}: AppHeaderProps) {
  const insets = useSafeAreaInsets();
  const dealer = useAuthStore((s) => s.dealer);

  const resolvedTitle = title ?? dealer?.name ?? "Dealer";
  // Prefer routeName over zoneName for the subtitle (migration to per-route windows).
  // Falls back to zoneName for dealers not yet assigned a route.
  const resolvedSubtitle =
    (subtitle ??
    [dealer?.routeName || dealer?.zoneName, dealer?.code].filter(Boolean).join(" · ")) ||
    "";

  return (
    <View
      style={[
        styles.root,
        { paddingTop: Math.max(insets.top + 6, 38) },
      ]}
    >
      <View style={styles.titleCol}>
        <Text style={styles.title} numberOfLines={1}>
          {resolvedTitle}
        </Text>
        {resolvedSubtitle ? (
          <Text style={styles.subtitle} numberOfLines={1}>
            {resolvedSubtitle}
          </Text>
        ) : null}
      </View>

      <View style={styles.right}>
        {onPriceChartPress ? (
          <TouchableOpacity
            onPress={onPriceChartPress}
            activeOpacity={0.6}
            style={styles.iconBtn}
            accessibilityRole="button"
            accessibilityLabel="Price chart"
          >
            <Text style={styles.chartIcon}>🏷️</Text>
          </TouchableOpacity>
        ) : null}

        <TouchableOpacity
          onPress={onBellPress}
          activeOpacity={0.6}
          style={styles.iconBtn}
          accessibilityRole="button"
          accessibilityLabel="Notifications"
        >
          <Text style={styles.bellIcon}>🔔</Text>
          {unreadNotifications ? <View style={styles.unreadDot} /> : null}
        </TouchableOpacity>

        <TouchableOpacity
          onPress={onProfilePress}
          activeOpacity={0.7}
          style={styles.avatar}
          accessibilityRole="button"
          accessibilityLabel="Profile"
        >
          <Text style={styles.avatarText}>{initialsFromName(dealer?.name)}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingBottom: 10,
    backgroundColor: colors.card,
    borderBottomWidth: 0.5,
    borderBottomColor: colors.border,
  },
  titleCol: {
    flex: 1,
    marginRight: 12,
  },
  title: {
    fontSize: 14,
    fontFamily: fonts.bold,
    color: colors.foreground,
  },
  subtitle: {
    fontSize: 11,
    fontFamily: fonts.medium,
    color: colors.mutedForeground,
    marginTop: 1,
  },
  right: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  iconBtn: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
  },
  bellIcon: {
    fontSize: 18,
  },
  chartIcon: {
    fontSize: 18,
  },
  unreadDot: {
    position: "absolute",
    top: 6,
    right: 8,
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: "#EF4444",
    borderWidth: 1.5,
    borderColor: colors.card,
  },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.primaryLight,
    borderWidth: 0.5,
    borderColor: colors.primaryLight2,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: {
    fontSize: 12,
    fontFamily: fonts.bold,
    color: colors.primary,
    letterSpacing: 0.3,
  },
});