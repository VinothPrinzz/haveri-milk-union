import React, { useEffect, useRef } from "react";
import {
  Animated,
  Easing,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { colors, fonts } from "../lib/theme";

/**
 * Skeleton placeholders — the Blinkit-style progressive loading pattern.
 *
 * The app shell renders immediately; each section (category bar, product
 * grid, …) shows a pulsing placeholder until ITS data arrives, instead of
 * the whole screen blocking on one loader or flashing a wrong empty state
 * ("No products found") while the request is still in flight.
 */

export function Skeleton({ style }: { style?: StyleProp<ViewStyle> }) {
  const pulse = useRef(new Animated.Value(0.45)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 700,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0.45,
          duration: 700,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  return <Animated.View style={[styles.base, style, { opacity: pulse }]} />;
}

/** Two-column grid of card-shaped placeholders (Home / category detail). */
export function ProductGridSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <View>
      {Array.from({ length: rows }).map((_, r) => (
        <View key={r} style={styles.gridRow}>
          <Skeleton style={styles.productCard} />
          <Skeleton style={styles.productCard} />
        </View>
      ))}
    </View>
  );
}

/** Horizontal row of pill placeholders (Home category bar). */
export function CategoryBarSkeleton() {
  return (
    <View style={styles.pillRow}>
      {Array.from({ length: 4 }).map((_, i) => (
        <Skeleton key={i} style={styles.pill} />
      ))}
    </View>
  );
}

/** Grid of square-ish tiles (Categories tab directory). */
export function CategoryGridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <View style={styles.catGrid}>
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} style={styles.catCard} />
      ))}
    </View>
  );
}

/**
 * Inline "couldn't load this section" state with a Retry button. Shown
 * only when a section failed AND has no cached data — never a dead end,
 * never a full-screen error.
 */
export function SectionLoadFailed({
  label,
  onRetry,
}: {
  label: string;
  onRetry: () => void;
}) {
  return (
    <View style={styles.failWrap}>
      <Text style={styles.failEmoji}>📡</Text>
      <Text style={styles.failTitle}>{label}</Text>
      <Text style={styles.failSub}>
        Your connection seems slow — we'll keep trying.
      </Text>
      <TouchableOpacity
        onPress={onRetry}
        activeOpacity={0.8}
        style={styles.retryBtn}
        accessibilityRole="button"
      >
        <Text style={styles.retryText}>Retry now</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    backgroundColor: colors.border,
    borderRadius: 8,
  },

  // Product grid
  gridRow: {
    flexDirection: "row",
    paddingHorizontal: 12,
    gap: 8,
    marginBottom: 8,
  },
  productCard: {
    flex: 1,
    height: 172,
  },

  // Category pills
  pillRow: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 12,
  },
  pill: {
    width: 76,
    height: 32,
    borderRadius: 16,
  },

  // Categories directory
  catGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    paddingHorizontal: 12,
    gap: 8,
    paddingTop: 12,
  },
  catCard: {
    width: "31%",
    flexGrow: 1,
    height: 104,
  },

  // Section failure
  failWrap: {
    alignItems: "center",
    paddingVertical: 40,
    paddingHorizontal: 24,
  },
  failEmoji: { fontSize: 34 },
  failTitle: {
    fontSize: 13,
    fontFamily: fonts.bold,
    color: colors.foreground,
    marginTop: 10,
  },
  failSub: {
    fontSize: 11,
    fontFamily: fonts.medium,
    color: colors.mutedForeground,
    marginTop: 4,
    textAlign: "center",
  },
  retryBtn: {
    marginTop: 14,
    paddingVertical: 9,
    paddingHorizontal: 22,
    borderRadius: 8,
    backgroundColor: colors.primary,
  },
  retryText: {
    fontSize: 12,
    fontFamily: fonts.extrabold,
    color: colors.primaryForeground,
  },
});
