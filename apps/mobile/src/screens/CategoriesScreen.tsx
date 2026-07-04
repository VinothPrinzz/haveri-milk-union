import React, { useMemo, useState } from "react";
import {
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { colors, fonts } from "../lib/theme";
import AppHeader from "../components/AppHeader";
import DatePill from "../components/DatePill";
import ProductCard from "../components/ProductCard";
import {
  CategoryGridSkeleton,
  SectionLoadFailed,
} from "../components/Skeleton";
import { useAuthStore } from "../store/auth";
import { useCartStore } from "../store/cart";
import { useProducts, useCategories } from "../hooks/useProducts";
import { useWindowStatus } from "../hooks/useWindow";
import { useNotifications } from "../hooks/useNotifications";
import type { Category, Product } from "../lib/types";

/**
 * CategoriesScreen — directory + master-detail product browse.
 *
 * Two states, same tab (no extra navigation stack needed):
 *
 *   STATE A — Directory (default)
 *     • 2-col grid of category cards (icon + name + product count)
 *     • Tap a card → STATE B
 *
 *   STATE B — Category detail
 *     • Header switches to show the category name + back arrow
 *     • DatePill stays visible (adds still flow to the selected date)
 *     • 2-col products grid filtered to that category
 *     • Tap back → STATE A
 *
 * Search at the top of STATE A searches CATEGORY names only (not
 * products — Home owns product search). When the dealer types, only
 * matching categories show.
 *
 * Sticky View Indent bar appears in both states when the cart has
 * items, so the dealer can jump to checkout from anywhere.
 */

interface CategoriesScreenProps {
  onOpenIndent: () => void;
  onOpenIndentForDate: () => void;
  onOpenNotifications: () => void;
  onOpenProfile: () => void;
  onOpenPriceChart: () => void;
}

export default function CategoriesScreen({
  onOpenIndent,
  onOpenIndentForDate,
  onOpenNotifications,
  onOpenProfile,
  onOpenPriceChart,
}: CategoriesScreenProps) {
  const dealer = useAuthStore((s) => s.dealer);
  const cartItems = useCartStore((s) => s.items);
  const cartItemCount = useCartStore((s) => s.getItemCount());
  const cartGrand = useCartStore((s) => s.getGrandTotal());
  const cartProducts = useCartStore((s) => s.getItems());
  const addItem = useCartStore((s) => s.addItem);
  const removeItem = useCartStore((s) => s.removeItem);
  const setQuantity = useCartStore((s) => s.setQuantity);

  const catsQuery = useCategories();
  const productsQuery = useProducts();
  // Time-windows are route-based — fetch by routeId, not zoneId.
  const windowQuery = useWindowStatus(dealer?.routeId);
  const { data: notifs } = useNotifications();

  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const categories = catsQuery.data ?? [];
  const products = productsQuery.data ?? [];

  // Product count per category — shown on each card.
  const countByCategory = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of products) {
      map.set(p.categoryId, (map.get(p.categoryId) ?? 0) + 1);
    }
    return map;
  }, [products]);

  const filteredCategories = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return categories;
    return categories.filter((c) => c.name.toLowerCase().includes(q));
  }, [categories, search]);

  const productsInCategory = useMemo(() => {
    if (!selectedCategoryId) return [];
    return products.filter((p) => p.categoryId === selectedCategoryId);
  }, [products, selectedCategoryId]);

  const selectedCategory = categories.find((c) => c.id === selectedCategoryId);
  const unreadNotifications = (notifs ?? []).some((n) => !!n.unread);

  const toCartProduct = (p: Product) => ({
    id: p.id,
    name: p.name,
    icon: p.icon ?? "📦",
    unit: p.unit,
    basePrice: p.basePrice,
    dealerPrice: p.dealerPrice,
    mrp: p.mrp,
    gstPercent: p.gstPercent,
  });

  // Absolute-quantity setter for the ProductCard stepper's editable input.
  // addItem first when not in cart — setQuantity is a no-op for unknown items.
  const setItemQty = (product: Product, qty: number) => {
    if (qty <= 0) {
      setQuantity(product.id, 0);
      return;
    }
    if (!cartItems[product.id]) {
      addItem(toCartProduct(product));
    }
    setQuantity(product.id, qty);
  };

  // No `if (!dealer) return null` — the shell renders immediately and the
  // header/window pill fill in when the profile / window status arrive.

  // ── State B: category detail ──
  if (selectedCategory) {
    return (
      <View style={styles.root}>
        <AppHeader
          title={selectedCategory.name}
          subtitle={`${productsInCategory.length} product${
            productsInCategory.length === 1 ? "" : "s"
          }`}
          unreadNotifications={unreadNotifications}
          onBellPress={onOpenNotifications}
          onProfilePress={onOpenProfile}
          onPriceChartPress={onOpenPriceChart}
        />

        <ScrollView
          style={styles.scroll}
          contentContainerStyle={[
            styles.scrollContent,
            { paddingBottom: cartItemCount > 0 ? 100 : 24 },
          ]}
          showsVerticalScrollIndicator={false}
        >
          <TouchableOpacity
            onPress={() => setSelectedCategoryId(null)}
            activeOpacity={0.7}
            style={styles.backRow}
          >
            <Text style={styles.backArrow}>‹</Text>
            <Text style={styles.backText}>All categories</Text>
          </TouchableOpacity>

          <DatePill
            windowStatus={windowQuery.data ?? null}
            onPress={onOpenIndentForDate}
          />

          {productsInCategory.length === 0 ? (
            <View style={styles.empty}>
              <Text style={styles.emptyEmoji}>📭</Text>
              <Text style={styles.emptyTitle}>No products in this category</Text>
            </View>
          ) : (
            <View style={styles.grid}>
              {productsInCategory.map((p) => (
                <View key={p.id} style={styles.gridCell}>
                  <ProductCard
                    product={p}
                    quantity={cartItems[p.id]?.quantity ?? 0}
                    onAdd={() => addItem(toCartProduct(p))}
                    onRemove={() => removeItem(p.id)}
                    onSetQuantity={(qty) => setItemQty(p, qty)}
                  />
                </View>
              ))}
            </View>
          )}
        </ScrollView>

        {cartItemCount > 0 && (
          <StickyIndentBar
            count={cartItemCount}
            productCount={cartProducts.length}
            total={cartGrand}
            onPress={onOpenIndent}
          />
        )}
      </View>
    );
  }

  // ── State A: directory ──
  return (
    <View style={styles.root}>
      <AppHeader
        title="Categories"
        subtitle="Browse products by type"
        unreadNotifications={unreadNotifications}
        onBellPress={onOpenNotifications}
        onProfilePress={onOpenProfile}
        onPriceChartPress={onOpenPriceChart}
      />

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.scrollContent,
          { paddingBottom: cartItemCount > 0 ? 100 : 24 },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <DatePill
          windowStatus={windowQuery.data ?? null}
          onPress={onOpenIndentForDate}
        />

        {/* Search (categories only) */}
        <View style={styles.searchWrap}>
          <View style={styles.searchBar}>
            <Text style={styles.searchIcon}>🔍</Text>
            <TextInput
              style={styles.searchInput}
              value={search}
              onChangeText={setSearch}
              placeholder="Find a category…"
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

        {/* Category grid — skeleton while loading, inline retry on
            failure, real empty state only once the data has answered. */}
        {catsQuery.isPending ? (
          <CategoryGridSkeleton />
        ) : catsQuery.isError && categories.length === 0 ? (
          <SectionLoadFailed
            label="Couldn't load categories"
            onRetry={() => catsQuery.refetch()}
          />
        ) : filteredCategories.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyEmoji}>🔎</Text>
            <Text style={styles.emptyTitle}>No matching categories</Text>
          </View>
        ) : (
          <View style={styles.catGrid}>
            {filteredCategories.map((c) => (
              <TouchableOpacity
                key={c.id}
                activeOpacity={0.7}
                onPress={() => setSelectedCategoryId(c.id)}
                style={styles.catCard}
              >
                <View style={styles.catThumb}>
                  <Text style={styles.catEmoji}>{c.icon ?? "📦"}</Text>
                </View>
                <Text style={styles.catName} numberOfLines={1}>
                  {c.name}
                </Text>
                <Text style={styles.catCount}>
                  {countByCategory.get(c.id) ?? 0} product
                  {(countByCategory.get(c.id) ?? 0) === 1 ? "" : "s"}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        )}
      </ScrollView>

      {cartItemCount > 0 && (
        <StickyIndentBar
          count={cartItemCount}
          productCount={cartProducts.length}
          total={cartGrand}
          onPress={onOpenIndent}
        />
      )}
    </View>
  );
}

// ── Sticky bar — local to this screen for now; can be promoted to a
//    shared component later if Orders/Profile screens want it too.
function StickyIndentBar({
  count,
  productCount,
  total,
  onPress,
}: {
  count: number;
  productCount: number;
  total: number;
  onPress: () => void;
}) {
  return (
    <View style={styles.stickyWrap}>
      <TouchableOpacity
        activeOpacity={0.85}
        onPress={onPress}
        style={styles.stickyBar}
      >
        <View style={styles.stickyCount}>
          <Text style={styles.stickyCountText}>{count}</Text>
        </View>
        <View style={styles.stickyInfo}>
          <Text style={styles.stickyItems}>
            {productCount} product{productCount === 1 ? "" : "s"}
          </Text>
          <Text style={styles.stickyTotal}>₹{total.toFixed(2)}</Text>
        </View>
        <Text style={styles.stickyCta}>View indent →</Text>
      </TouchableOpacity>
    </View>
  );
}

// ════════════════════════════════════════════════════════════════════
// Styles
// ════════════════════════════════════════════════════════════════════

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: 24 },

  // ── Search ──
  searchWrap: { paddingHorizontal: 12, paddingTop: 10 },
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

  // ── Category grid ──
  catGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    paddingHorizontal: 12,
    paddingTop: 12,
    gap: 8,
  },
  catCard: {
    width: "48.5%",
    backgroundColor: colors.card,
    borderRadius: 6,
    borderWidth: 0.5,
    borderColor: colors.border,
    padding: 12,
    alignItems: "center",
  },
  catThumb: {
    width: 56,
    height: 56,
    borderRadius: 6,
    backgroundColor: colors.background,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 8,
  },
  catEmoji: { fontSize: 30 },
  catName: {
    fontSize: 12,
    fontFamily: fonts.bold,
    color: colors.foreground,
    textAlign: "center",
  },
  catCount: {
    fontSize: 11,
    fontFamily: fonts.medium,
    color: colors.mutedForeground,
    marginTop: 2,
  },

  // ── Back row (state B) ──
  backRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingTop: 10,
    gap: 4,
  },
  backArrow: {
    fontSize: 22,
    fontFamily: fonts.medium,
    color: colors.primary,
    lineHeight: 24,
  },
  backText: {
    fontSize: 12,
    fontFamily: fonts.semibold,
    color: colors.primary,
  },

  // ── Product grid (state B) ──
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    paddingHorizontal: 12,
    paddingTop: 12,
    gap: 8,
  },
  gridCell: { width: "48.5%" },

  // ── Empty state ──
  empty: {
    alignItems: "center",
    paddingVertical: 60,
    paddingHorizontal: 24,
  },
  emptyEmoji: { fontSize: 38 },
  emptyTitle: {
    fontSize: 13,
    fontFamily: fonts.bold,
    color: colors.foreground,
    marginTop: 10,
    textAlign: "center",
  },

  // ── Sticky bar (same shape as HomeScreen's) ──
  stickyWrap: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 12,
    paddingBottom: 10,
  },
  stickyBar: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.foreground,
    borderRadius: 6,
    paddingVertical: 11,
    paddingHorizontal: 12,
    gap: 10,
  },
  stickyCount: {
    minWidth: 24,
    height: 22,
    paddingHorizontal: 6,
    borderRadius: 4,
    backgroundColor: colors.yellowAccent,
    alignItems: "center",
    justifyContent: "center",
  },
  stickyCountText: {
    fontSize: 12,
    fontFamily: fonts.extrabold,
    color: colors.foreground,
  },
  stickyInfo: { flex: 1 },
  stickyItems: {
    fontSize: 10,
    fontFamily: fonts.medium,
    color: "rgba(255,255,255,0.6)",
  },
  stickyTotal: {
    fontSize: 14,
    fontFamily: fonts.bold,
    color: colors.primaryForeground,
    marginTop: 1,
  },
  stickyCta: {
    fontSize: 12,
    fontFamily: fonts.extrabold,
    color: colors.yellowAccent,
  },
});