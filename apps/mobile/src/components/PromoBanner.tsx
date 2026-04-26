import React from "react";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { colors, fonts, gradients, cssAngleToPoints } from "../lib/theme";

/**
 * PromoBanner — horizontal scroll of 200×86 gradient cards.
 *
 * Mockup CSS (dealer-app.html lines 142-152):
 *   .banner-card  { flex-shrink:0; width:200px; height:86px; border-radius:14px;
 *                   align-items:center; padding:12px; gap:9px; position:relative; overflow:hidden }
 *   .banner-card.b1 { background: linear-gradient(135deg, #1448CC, #0D33A0) }  // brand
 *   .banner-card.b2 { background: linear-gradient(135deg, #065F46, #047857) }  // green
 *   .banner-card.b3 { background: linear-gradient(135deg, #92400E, #B45309) }  // amber
 *   .banner-card::after { 75×75 rgba(255,255,255,0.08); right:-18; top:-18; border-radius:50% }
 *   .banner-emoji { font-size: 32px; z-index: 1 }
 *   .bt1          { font-size: 10px; color: rgba(255,255,255,0.7); font-weight: 600 }
 *   .bt2          { font-size: 12px; color: white; font-weight: 800; line-height: 1.3 }
 *   .bt-badge     { bg rgba(252,211,77,0.25); color #FCD34D; 8px extrabold; padding: 2px 6px;
 *                   border-radius: 3px; margin-top: 3px; text-transform: uppercase; letter-spacing: 0.4px }
 */

export type PromoBannerVariant = "brand" | "green" | "amber";

export interface PromoBannerItem {
  id: string;
  variant: PromoBannerVariant;
  emoji: string;
  sub: string;          // bt1 — "This Week Only", "New Launch", "Notice"
  title: string;        // bt2 — supports "\n" for multi-line
  badge?: string;       // bt-badge — optional yellow pill ("Buy 50+ · Save 5%")
}

interface PromoBannerProps {
  items: PromoBannerItem[];
  onPress?: (item: PromoBannerItem) => void;
}

// ── Variant → gradient resolver ────────────────────────────────────────

const VARIANT_GRADIENTS = {
  brand: gradients.bannerBrand,
  green: gradients.bannerGreen,
  amber: gradients.bannerAmber,
} as const;

export default function PromoBanner({ items, onPress }: PromoBannerProps) {
  if (items.length === 0) return null;

  return (
    <View style={styles.wrap}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scroll}
      >
        {items.map((item) => (
          <BannerCard key={item.id} item={item} onPress={onPress} />
        ))}
      </ScrollView>
    </View>
  );
}

// ── Individual card ────────────────────────────────────────────────────

function BannerCard({
  item,
  onPress,
}: {
  item: PromoBannerItem;
  onPress?: (item: PromoBannerItem) => void;
}) {
  const { colors: gradColors, angle } = VARIANT_GRADIENTS[item.variant];
  const { start, end } = cssAngleToPoints(angle);

  const CardContent = (
    <LinearGradient
      colors={gradColors as unknown as [string, string]}
      start={start}
      end={end}
      style={styles.card}
    >
      {/* Decorative circle */}
      <View style={styles.decor} />

      <Text style={styles.emoji}>{item.emoji}</Text>

      <View style={styles.textCol}>
        <Text style={styles.bt1} numberOfLines={1}>{item.sub}</Text>
        <Text style={styles.bt2} numberOfLines={2}>{item.title}</Text>
        {item.badge && (
          <View style={styles.badgeWrap}>
            <Text style={styles.badge} numberOfLines={1}>{item.badge}</Text>
          </View>
        )}
      </View>
    </LinearGradient>
  );

  if (!onPress) return CardContent;

  return (
    <TouchableOpacity activeOpacity={0.85} onPress={() => onPress(item)}>
      {CardContent}
    </TouchableOpacity>
  );
}

// ════════════════════════════════════════════════════════════════════════

const styles = StyleSheet.create({
  wrap: {
    paddingTop: 12,      // mockup: padding: 12px 14px 0
  },
  scroll: {
    paddingHorizontal: 14,
    gap: 9,              // mockup: gap: 9px
  },
  card: {
    width: 200,          // mockup
    height: 86,
    borderRadius: 14,
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
    gap: 9,
    position: "relative",
    overflow: "hidden",
  },
  decor: {
    position: "absolute",
    width: 75,           // mockup: 75×75
    height: 75,
    right: -18,
    top: -18,
    borderRadius: 999,
    backgroundColor: colors.white08,
  },
  emoji: {
    fontSize: 32,        // mockup
    zIndex: 1,
  },
  textCol: {
    flex: 1,
    zIndex: 1,
  },
  bt1: {
    fontSize: 10,
    fontFamily: fonts.semibold,
    color: "rgba(255,255,255,0.7)",
  },
  bt2: {
    fontSize: 12,
    fontFamily: fonts.extrabold,
    color: colors.primaryForeground,
    lineHeight: 16,      // 12 × 1.3 ≈ 16
    marginTop: 1,
  },
  badgeWrap: {
    alignSelf: "flex-start",
    backgroundColor: "rgba(252,211,77,0.25)",
    paddingVertical: 2,
    paddingHorizontal: 6,
    borderRadius: 3,
    marginTop: 3,
  },
  badge: {
    fontSize: 8,         // mockup
    fontFamily: fonts.extrabold,
    color: colors.yellowAccent,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
});