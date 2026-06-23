// src/screens/PriceChartScreen.tsx
//
// A read-only price list of every product, opened from the 🏷️ button next
// to the notification bell in the app header. Dealers see the Dealer-Price
// (gross, GST-inclusive) — the same price they're billed at — grouped by
// category. Reuses the existing /products + /categories data (no new API).

import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Image,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors, fonts } from "../lib/theme";
import { useProducts, useCategories } from "../hooks/useProducts";
import type { Product } from "../lib/types";

interface PriceChartScreenProps {
  onBack: () => void;
}

/** Dealer-Price (gross) the dealer is billed at, with sensible fallbacks. */
function dealerPriceOf(p: Product): number {
  return Number(p.dealerPrice ?? p.mrp ?? p.basePrice ?? 0) || 0;
}

/** MRP (sticker price). 0 when the backend doesn't supply one. */
function mrpOf(p: Product): number {
  return Number(p.mrp ?? 0) || 0;
}

/** Whole rupees → no decimals; fractional → 2dp. */
function formatPrice(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

interface Section {
  title: string;
  data: Product[];
}

/**
 * A single product row. Extracted into its own component so each row can
 * own the image-load-error state needed to fall back to the emoji icon.
 */
function PriceRow({ item, isLast }: { item: Product; isLast: boolean }) {
  const [imageError, setImageError] = useState(false);

  const dealerPrice = dealerPriceOf(item);
  const mrp = mrpOf(item);
  // Only surface the MRP when it's meaningfully above the dealer price —
  // showing "MRP ₹100 / ₹100" would just be noise.
  const showMrp = mrp > 0 && mrp > dealerPrice;
  const hasImage = !!item.imageUrl && !imageError;

  return (
    <View style={[styles.row, isLast && styles.rowLast]}>
      <View style={styles.rowThumb}>
        {hasImage ? (
          <Image
            source={{ uri: item.imageUrl! }}
            style={styles.rowThumbImage}
            resizeMode="contain"
            onError={() => setImageError(true)}
            accessibilityIgnoresInvertColors
          />
        ) : (
          <Text style={styles.rowEmoji}>{item.icon ?? "📦"}</Text>
        )}
      </View>
      <View style={styles.rowBody}>
        <Text style={styles.rowName} numberOfLines={2}>
          {item.name}
        </Text>
        <Text style={styles.rowUnit}>{item.unit}</Text>
      </View>
      <View style={styles.priceCol}>
        {showMrp ? (
          <Text style={styles.rowMrp}>MRP ₹{formatPrice(mrp)}</Text>
        ) : null}
        <Text style={styles.rowPrice}>₹{formatPrice(dealerPrice)}</Text>
      </View>
    </View>
  );
}

export default function PriceChartScreen({ onBack }: PriceChartScreenProps) {
  const insets = useSafeAreaInsets();
  const productsQuery = useProducts();
  const catsQuery = useCategories();

  const [search, setSearch] = useState("");

  const products = productsQuery.data ?? [];
  const categories = catsQuery.data ?? [];

  // Group products by category. Sections follow the category sort order;
  // any product whose category isn't in the list lands in "Other".
  const sections = useMemo<Section[]>(() => {
    const q = search.trim().toLowerCase();
    const matches = (p: Product) => !q || p.name.toLowerCase().includes(q);

    const byCategory = new Map<string, Product[]>();
    for (const p of products) {
      if (!matches(p)) continue;
      const list = byCategory.get(p.categoryId) ?? [];
      list.push(p);
      byCategory.set(p.categoryId, list);
    }

    const out: Section[] = [];
    const seen = new Set<string>();
    for (const c of categories) {
      const data = byCategory.get(c.id);
      if (data && data.length) {
        out.push({ title: c.name, data });
        seen.add(c.id);
      }
    }
    // Catch products whose category isn't in the categories response.
    const leftovers: Product[] = [];
    for (const [catId, list] of byCategory) {
      if (!seen.has(catId)) leftovers.push(...list);
    }
    if (leftovers.length) out.push({ title: "Other", data: leftovers });

    return out;
  }, [products, categories, search]);

  const isLoading = productsQuery.isLoading || catsQuery.isLoading;
  const isError = productsQuery.isError || catsQuery.isError;
  const totalCount = products.length;

  return (
    <View style={styles.root}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: Math.max(insets.top + 8, 42) }]}>
        <View style={styles.headerTop}>
          <TouchableOpacity
            onPress={onBack}
            style={styles.backBtn}
            activeOpacity={0.7}
            accessibilityLabel="Go back"
          >
            <Text style={styles.backIcon}>←</Text>
          </TouchableOpacity>
          <Text style={styles.title}>Price Chart</Text>
        </View>
        <Text style={styles.subtitle}>
          Dealer prices (incl. GST){totalCount ? ` · ${totalCount} products` : ""}
        </Text>
      </View>

      {/* Search */}
      <View style={styles.searchWrap}>
        <View style={styles.searchBar}>
          <Text style={styles.searchIcon}>🔍</Text>
          <TextInput
            style={styles.searchInput}
            value={search}
            onChangeText={setSearch}
            placeholder="Search products…"
            placeholderTextColor={colors.mutedForeground}
            returnKeyType="search"
          />
          {search ? (
            <TouchableOpacity onPress={() => setSearch("")} activeOpacity={0.7}>
              <Text style={styles.searchClear}>✕</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </View>

      {/* Body */}
      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : isError ? (
        <View style={styles.center}>
          <Text style={styles.emptyEmoji}>⚠️</Text>
          <Text style={styles.emptyTitle}>Couldn't load prices</Text>
          <TouchableOpacity
            activeOpacity={0.8}
            onPress={() => {
              productsQuery.refetch();
              catsQuery.refetch();
            }}
            style={styles.retryBtn}
          >
            <Text style={styles.retryBtnText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(item) => item.id}
          stickySectionHeadersEnabled={false}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          initialNumToRender={16}
          renderSectionHeader={({ section }) => (
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>{section.title}</Text>
            </View>
          )}
          renderItem={({ item, index, section }) => (
            <PriceRow item={item} isLast={index === section.data.length - 1} />
          )}
          ListEmptyComponent={
            <View style={styles.center}>
              <Text style={styles.emptyEmoji}>🔎</Text>
              <Text style={styles.emptyTitle}>No products found</Text>
              {search ? (
                <Text style={styles.emptySub}>No matches for “{search}”</Text>
              ) : null}
            </View>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },

  // Header
  header: {
    backgroundColor: colors.card,
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerTop: { flexDirection: "row", alignItems: "center", gap: 9 },
  backBtn: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: colors.muted,
    alignItems: "center",
    justifyContent: "center",
  },
  backIcon: {
    fontSize: 18,
    fontFamily: fonts.bold,
    color: colors.foreground,
    lineHeight: 20,
  },
  title: { fontSize: 16, fontFamily: fonts.extrabold, color: colors.foreground },
  subtitle: {
    fontSize: 10,
    fontFamily: fonts.medium,
    color: colors.mutedForeground,
    marginTop: 3,
    marginLeft: 41,
  },

  // Search
  searchWrap: {
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 4,
  },
  searchBar: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.card,
    borderRadius: 6,
    borderWidth: 0.5,
    borderColor: colors.border,
    paddingVertical: 9,
    paddingHorizontal: 12,
    gap: 8,
  },
  searchIcon: { fontSize: 14 },
  searchInput: {
    flex: 1,
    fontSize: 13,
    fontFamily: fonts.medium,
    color: colors.foreground,
    padding: 0,
  },
  searchClear: {
    fontSize: 16,
    color: colors.mutedForeground,
    paddingHorizontal: 4,
  },

  // List
  listContent: { paddingHorizontal: 12, paddingTop: 8, paddingBottom: 32 },
  sectionHeader: { paddingTop: 14, paddingBottom: 6 },
  sectionTitle: {
    fontSize: 12,
    fontFamily: fonts.bold,
    color: colors.mutedForeground,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },

  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderLeftWidth: 0.5,
    borderRightWidth: 0.5,
    borderTopWidth: 0.5,
    paddingVertical: 10,
    paddingHorizontal: 11,
  },
  rowLast: {
    borderBottomWidth: 0.5,
    borderBottomLeftRadius: 6,
    borderBottomRightRadius: 6,
  },
  rowThumb: {
    width: 36,
    height: 36,
    borderRadius: 6,
    backgroundColor: colors.background,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  rowThumbImage: { width: "100%", height: "100%" },
  rowEmoji: { fontSize: 18 },
  rowBody: { flex: 1 },
  rowName: {
    fontSize: 12,
    fontFamily: fonts.semibold,
    color: colors.foreground,
    lineHeight: 16,
  },
  rowUnit: {
    fontSize: 11,
    fontFamily: fonts.medium,
    color: colors.mutedForeground,
    marginTop: 1,
  },
  priceCol: { alignItems: "flex-end" },
  rowMrp: {
    fontSize: 11,
    fontFamily: fonts.medium,
    color: colors.mutedForeground,
    textDecorationLine: "line-through",
    marginBottom: 1,
  },
  rowPrice: {
    fontSize: 14,
    fontFamily: fonts.extrabold,
    color: colors.foreground,
  },

  // States
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 80,
    paddingHorizontal: 24,
  },
  emptyEmoji: { fontSize: 38 },
  emptyTitle: {
    fontSize: 13,
    fontFamily: fonts.bold,
    color: colors.foreground,
    marginTop: 10,
  },
  emptySub: {
    fontSize: 11,
    fontFamily: fonts.medium,
    color: colors.mutedForeground,
    marginTop: 4,
    textAlign: "center",
  },
  retryBtn: {
    marginTop: 14,
    paddingVertical: 8,
    paddingHorizontal: 22,
    borderRadius: 4,
    backgroundColor: colors.primary,
  },
  retryBtnText: { fontSize: 12, fontFamily: fonts.bold, color: colors.primaryForeground },
});
