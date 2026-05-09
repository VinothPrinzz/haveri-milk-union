import React from "react";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { colors, fonts, shadows } from "../lib/theme";

/**
 * CategoryBar — horizontal scroll of category pills (spec §6.5).
 *
 * Mockup CSS (dealer-app.html lines 154-161):
 *   .cats-wrap   { padding: 12px 14px 0 }
 *   .cats-scroll { display: flex; gap: 7px; overflow-x: auto }
 *   .cat-pill    { flex-shrink: 0; gap: 5px; padding: 7px 12px; border-radius: 999px;
 *                  background: #FFFFFF; border: 1.5px solid #E5E7EB; box-shadow: shadow-sm }
 *   .cat-pill.active { background: #1448CC; border-color: #1448CC }
 *   .cat-pill .ci    { font-size: 13px }
 *   .cat-pill .cl    { font-size: 10px; font-weight: 700; color: #374151 }
 *   .cat-pill.active .cl { color: white }
 *
 * The mockup always shows an "All" pill first (with 🥛 icon, active by default).
 * We render that automatically — parent just passes the list of real categories.
 */

export interface CategoryItem {
  id: string;
  name: string;
  icon: string;   // emoji
}

interface CategoryBarProps {
  categories: CategoryItem[];
  selectedId: string;               // "all" or a category.id
  onSelect: (id: string) => void;
  /** Emoji used for the "All" pill. Mockup uses 🥛. */
  allIcon?: string;
  /** Label for the "All" pill. Defaults to "All". */
  allLabel?: string;
}

const ALL_ID = "all";

export default function CategoryBar({
  categories,
  selectedId,
  onSelect,
  allIcon = "🥛",
  allLabel = "All",
}: CategoryBarProps) {
  const items: CategoryItem[] = [
    { id: ALL_ID, name: allLabel, icon: allIcon },
    ...categories,
  ];

  return (
    <View style={styles.wrap}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scroll}
      >
        {items.map((cat) => {
          const active = cat.id === selectedId;
          return (
            <TouchableOpacity
              key={cat.id}
              activeOpacity={0.8}
              onPress={() => onSelect(cat.id)}
              style={[styles.pill, active && styles.pillActive]}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              accessibilityLabel={cat.name}
            >
              <Text style={styles.icon}>{cat.icon}</Text>
              <Text style={[styles.label, active && styles.labelActive]}>
                {cat.name}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    paddingTop: 12,           // mockup
  },
  scroll: {
    paddingHorizontal: 14,
    gap: 7,                   // mockup
  },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,                   // mockup
    paddingVertical: 7,       // mockup: padding: 7px 12px
    paddingHorizontal: 12,
    borderRadius: 999,
    backgroundColor: colors.card,
    borderWidth: 1.5,
    borderColor: colors.border,
    ...shadows.sm,
  },
  pillActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  icon: {
    fontSize: 13,             // mockup
    lineHeight: 15,
  },
  label: {
    fontSize: 10,             // mockup (not 11 as summary claimed)
    fontFamily: fonts.bold,
    color: colors.ink2,
  },
  labelActive: {
    color: colors.primaryForeground,
  },
});