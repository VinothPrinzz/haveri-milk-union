import React from "react";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { colors, fonts, shadows } from "../lib/theme";

/**
 * ReorderStrip — "🔄 Order Again" horizontal scroll of last-ordered items (spec §6.6).
 *
 * Mockup CSS (dealer-app.html lines 168-175):
 *   .reorder-strip { display:flex; gap:9px; padding:0 14px; overflow-x:auto }
 *   .reorder-card  { flex-shrink:0; width:84px; background:#FFFFFF;
 *                    border:1.5px solid #E5E7EB; border-radius:14px;
 *                    padding:9px 7px; text-align:center; shadow-sm; position:relative }
 *   .rc-emoji      { font-size:24px; display:block; margin-bottom:3px }
 *   .rc-name       { font-size:8px; font-weight:700; color:#374151; line-height:1.3 }
 *   .rc-qty        { font-size:8px; color:#6B7280; font-weight:600; margin-top:2px }
 *   .rc-add        { position:absolute; bottom:-1px; right:-1px;
 *                    width:20px; height:20px; background:#1448CC;
 *                    border-radius:5px 0 14px 0;       // top-left 5, bottom-right 14
 *                    font-size:12px; font-weight:900; color:white }
 *
 * On the amber (closing-soon) variant shown in screen 04, border + + button are amber instead
 * of brand — controlled via `accent` prop.
 */

export interface ReorderItem {
  productId: string;
  name: string;
  emoji: string;
  lastQuantity: number;
}

interface ReorderStripProps {
  items: ReorderItem[];
  onAdd: (item: ReorderItem) => void;
  /** Color for the `+` corner button. Default = brand blue; use "amber" on closing-soon state. */
  accent?: "primary" | "warning";
}

export default function ReorderStrip({
  items,
  onAdd,
  accent = "primary",
}: ReorderStripProps) {
  if (items.length === 0) return null;

  const accentColor = accent === "warning" ? colors.warning : colors.primary;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.scroll}
    >
      {items.map((item) => (
        <View
          key={item.productId}
          style={[
            styles.card,
            accent === "warning" && { borderColor: colors.warning },
          ]}
        >
          <Text style={styles.emoji}>{item.emoji}</Text>
          <Text style={styles.name} numberOfLines={2}>{item.name}</Text>
          <Text style={styles.qty}>×{item.lastQuantity} last time</Text>

          {/* Corner + button, tucks into bottom-right */}
          <TouchableOpacity
            activeOpacity={0.75}
            onPress={() => onAdd(item)}
            style={[styles.addBtn, { backgroundColor: accentColor }]}
            accessibilityRole="button"
            accessibilityLabel={`Add ${item.name} again`}
          >
            <Text style={styles.addIcon}>+</Text>
          </TouchableOpacity>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: {
    paddingHorizontal: 14,    // mockup
    gap: 9,                   // mockup
    paddingVertical: 2,       // small breathing room so shadow isn't clipped
  },
  card: {
    width: 84,                // mockup (not 90 as summary claimed)
    backgroundColor: colors.card,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: 14,
    paddingVertical: 9,       // mockup: padding: 9px 7px
    paddingHorizontal: 7,
    alignItems: "center",
    position: "relative",
    overflow: "hidden",       // clip the corner button to the card's curves
    ...shadows.sm,
  },
  emoji: {
    fontSize: 24,             // mockup
    marginBottom: 3,
  },
  name: {
    fontSize: 8,              // mockup
    fontFamily: fonts.bold,
    color: colors.ink2,
    lineHeight: 10.4,         // 8 × 1.3
    textAlign: "center",
  },
  qty: {
    fontSize: 8,
    fontFamily: fonts.semibold,
    color: colors.mutedForeground,
    marginTop: 2,
  },
  addBtn: {
    position: "absolute",
    bottom: -1,               // mockup
    right: -1,
    width: 20,                // mockup
    height: 20,
    // border-radius: 5px 0 14px 0 → topLeft 5, topRight 0, bottomRight 14, bottomLeft 0
    borderTopLeftRadius: 5,
    borderTopRightRadius: 0,
    borderBottomRightRadius: 14,
    borderBottomLeftRadius: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  addIcon: {
    fontSize: 12,             // mockup
    fontFamily: fonts.headingBlack,
    color: colors.primaryForeground,
    lineHeight: 13,
  },
});