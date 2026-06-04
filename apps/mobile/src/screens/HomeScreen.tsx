// src/screens/HomeScreen.tsx  —  FULL FILE (drop-in replacement)
//
// WHAT CHANGED & WHY
//   The product grid was a plain <ScrollView> with filteredProducts.map().
//   With ~238 products — each ProductCard mounting a remote <Image> — every
//   card and bitmap was decoded into native memory at once. On low-end
//   Android devices that blows the per-app memory limit and the OS Low
//   Memory Killer terminates the app ("loading… then closes").
//
//   Fix: render the grid with <FlatList numColumns={2}>, which virtualizes
//   rows — only ~10–20 cards are ever mounted. The non-scrolling search bar
//   is kept ABOVE the FlatList (a TextInput inside a virtualized header can
//   lose focus on re-render); DatePill / banners / category pills / the
//   section header go in ListHeaderComponent and scroll with the grid.

import React, { useMemo, useState, useCallback } from "react";
import {
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { colors, fonts } from "../lib/theme";

// ── Components ─────────────────────────────────────────────────────
import AppHeader from "../components/AppHeader";
import DatePill from "../components/DatePill";
import PromoBanner, { type PromoBannerItem } from "../components/PromoBanner";
import CategoryBar, { type CategoryItem } from "../components/CategoryBar";
import ProductCard from "../components/ProductCard";

// ── Hooks + stores ─────────────────────────────────────────────────
import { useAuthStore } from "../store/auth";
import { useCartStore } from "../store/cart";
import { useTargetDateStore } from "../store/targetDate";
import { useWindowStatus } from "../hooks/useWindow";
import { useProducts, useCategories } from "../hooks/useProducts";
import { useBanners } from "../hooks/useBanners";
import { useNotifications } from "../hooks/useNotifications";
import type { Product, Banner } from "../lib/types";

interface HomeScreenProps {
  onOpenIndent: () => void;
  onOpenIndentForDate: () => void;
  onOpenNotifications: () => void;
  onOpenProfile: () => void;
}

const ALL_CATEGORY_ID = "all";

export default function HomeScreen({
  onOpenIndent,
  onOpenIndentForDate,
  onOpenNotifications,
  onOpenProfile,
}: HomeScreenProps) {
  const dealer = useAuthStore((s) => s.dealer);
  const refreshProfile = useAuthStore((s) => s.refreshProfile);

  // ── Cart ────────────────────────────────────────────────────────
  const cartItems = useCartStore((s) => s.items);
  const cartItemCount = useCartStore((s) => s.getItemCount());
  const cartGrand = useCartStore((s) => s.getGrandTotal());
  const cartProducts = useCartStore((s) => s.getItems());
  const addItem = useCartStore((s) => s.addItem);
  const removeItem = useCartStore((s) => s.removeItem);
  const setQuantity = useCartStore((s) => s.setQuantity);

  // ── Target date store ───────────────────────────────────────────
  const advanceIfWindowClosed = useTargetDateStore((s) => s.advanceIfWindowClosed);

  // ── API ─────────────────────────────────────────────────────────
  const windowQuery = useWindowStatus(dealer?.routeId);
  const productsQuery = useProducts();
  const catsQuery = useCategories();
  const bannersQuery = useBanners();
  const { data: notifs } = useNotifications();

  // ── Local state ─────────────────────────────────────────────────
  const [search, setSearch] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>(ALL_CATEGORY_ID);
  const [refreshing, setRefreshing] = useState(false);

  React.useEffect(() => {
    const closed = windowQuery.data?.state === "closed";
    if (closed) advanceIfWindowClosed(true);
  }, [windowQuery.data?.state, advanceIfWindowClosed]);

  // ── Derived data ────────────────────────────────────────────────
  const products = productsQuery.data ?? [];
  const categories = catsQuery.data ?? [];
  const banners = bannersQuery.data ?? [];

  const filteredProducts = useMemo(() => {
    const q = search.trim().toLowerCase();
    return products.filter((p) => {
      if (
        selectedCategoryId !== ALL_CATEGORY_ID &&
        p.categoryId !== selectedCategoryId
      ) {
        return false;
      }
      if (q && !p.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [products, selectedCategoryId, search]);

  const categoryItems: CategoryItem[] = useMemo(
    () =>
      categories.map((c) => ({
        id: c.id,
        name: c.name,
        icon: c.icon ?? "📦",
      })),
    [categories]
  );

  const bannerItems: PromoBannerItem[] = useMemo(
    () =>
      banners.map((b: Banner, i: number) => ({
        id: b.id,
        emoji: "🎁",
        sub: b.subtitle ?? "",
        title: b.title,
        badge: b.category ?? undefined,
        variant: (["brand", "green", "amber"] as const)[i % 3],
      })),
    [banners]
  );

  const unreadNotifications = (notifs ?? []).some((n) => !!n.unread);

  const selectedCategoryName =
    selectedCategoryId === ALL_CATEGORY_ID
      ? "All products"
      : categoryItems.find((c) => c.id === selectedCategoryId)?.name ?? "Products";

  // ── Handlers ────────────────────────────────────────────────────
  const handleRefresh = async () => {
    setRefreshing(true);
    await Promise.all([
      productsQuery.refetch(),
      catsQuery.refetch(),
      bannersQuery.refetch(),
      windowQuery.refetch(),
      refreshProfile(),
    ]);
    setRefreshing(false);
  };

  const toCartProduct = (p: Product) => ({
    id: p.id,
    name: p.name,
    icon: p.icon ?? "📦",
    unit: p.unit,
    basePrice: p.basePrice,
    mrp: p.mrp,
    gstPercent: p.gstPercent,
  });

  // Absolute-quantity setter — used by the ProductCard stepper's editable
  // input (and its +/-). Clamps to [0, stock] and removes at 0. addItem is
  // called first when the product isn't in the cart yet, because the store's
  // setQuantity is a no-op for products it doesn't know about.
  const setItemQty = useCallback(
    (productId: string, qty: number, product: Product) => {
      if (qty <= 0) {
        setQuantity(productId, 0); // removes item
        return;
      }
      if (!cartItems[productId]) {
        addItem(toCartProduct(product));
      }
      setQuantity(productId, qty);
    },
    [cartItems, addItem, setQuantity] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const renderItem = useCallback(
    ({ item }: { item: Product }) => (
      <View style={styles.gridCell}>
        <ProductCard
          product={item}
          quantity={cartItems[item.id]?.quantity ?? 0}
          onAdd={() => addItem(toCartProduct(item))}
          onRemove={() => removeItem(item.id)}
          onSetQuantity={(qty) => setItemQty(item.id, qty, item)}
        />
      </View>
    ),
    [cartItems, addItem, removeItem, setItemQty] // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Scrolls WITH the grid. No TextInput here, so re-rendering is safe.
  const ListHeader = (
    <View>
      <DatePill
        windowStatus={windowQuery.data ?? null}
        onPress={onOpenIndentForDate}
      />

      {bannerItems.length > 0 && <PromoBanner items={bannerItems} />}

      {categoryItems.length > 0 && (
        <CategoryBar
          categories={categoryItems}
          selectedId={selectedCategoryId}
          onSelect={setSelectedCategoryId}
        />
      )}

      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>{selectedCategoryName}</Text>
        <Text style={styles.sectionMeta}>
          {filteredProducts.length} item
          {filteredProducts.length === 1 ? "" : "s"}
        </Text>
      </View>
    </View>
  );

  const ListEmpty = (
    <View style={styles.empty}>
      <Text style={styles.emptyEmoji}>🔎</Text>
      <Text style={styles.emptyTitle}>No products found</Text>
      <Text style={styles.emptySub}>
        {search ? `No matches for "${search}"` : "Try another category"}
      </Text>
    </View>
  );

  // ── Render ──────────────────────────────────────────────────────
  if (!dealer) return null;

  return (
    <View style={styles.root}>
      <AppHeader
        unreadNotifications={unreadNotifications}
        onBellPress={onOpenNotifications}
        onProfilePress={onOpenProfile}
      />

      {/* Search bar — pinned ABOVE the list (keeps TextInput focus stable) */}
      <View style={styles.searchWrap}>
        <View
          style={[
            styles.searchBar,
            searchFocused && { borderColor: colors.primary },
          ]}
        >
          <Text style={styles.searchIcon}>🔍</Text>
          <TextInput
            style={styles.searchInput}
            value={search}
            onChangeText={setSearch}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
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

      {/* Virtualized product grid */}
      <FlatList
        data={filteredProducts}
        renderItem={renderItem}
        keyExtractor={(p) => p.id}
        numColumns={2}
        columnWrapperStyle={styles.gridRow}
        ListHeaderComponent={ListHeader}
        ListEmptyComponent={ListEmpty}
        contentContainerStyle={[
          styles.listContent,
          { paddingBottom: cartItemCount > 0 ? 100 : 24 },
          filteredProducts.length === 0 && styles.listContentEmpty,
        ]}
        showsVerticalScrollIndicator={false}
        // ── Virtualization / memory tuning ──
        removeClippedSubviews
        initialNumToRender={8}
        maxToRenderPerBatch={8}
        windowSize={5}
        updateCellsBatchingPeriod={50}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={colors.primary}
          />
        }
      />

      {/* Sticky View Indent bar */}
      {cartItemCount > 0 && (
        <View style={styles.stickyWrap}>
          <TouchableOpacity
            activeOpacity={0.85}
            onPress={onOpenIndent}
            style={styles.stickyBar}
            accessibilityRole="button"
            accessibilityLabel={`View indent, ${cartItemCount} items, ₹${cartGrand.toFixed(
              2
            )}`}
          >
            <View style={styles.stickyCount}>
              <Text style={styles.stickyCountText}>{cartItemCount}</Text>
            </View>
            <View style={styles.stickyInfo}>
              <Text style={styles.stickyItems}>
                {cartProducts.length} product
                {cartProducts.length === 1 ? "" : "s"}
              </Text>
              <Text style={styles.stickyTotal}>₹{cartGrand.toFixed(2)}</Text>
            </View>
            <Text style={styles.stickyCta}>View indent →</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

// ════════════════════════════════════════════════════════════════════
// Styles
// ════════════════════════════════════════════════════════════════════

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
  },

  // ── List ──
  listContent: { paddingBottom: 24 },
  listContentEmpty: { flexGrow: 1 },

  // ── Search ──
  searchWrap: {
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 4,
    backgroundColor: colors.background,
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

  // ── Section header ──
  sectionHeader: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingTop: 14,
    paddingBottom: 6,
  },
  sectionTitle: {
    fontSize: 13,
    fontFamily: fonts.bold,
    color: colors.foreground,
  },
  sectionMeta: {
    fontSize: 11,
    fontFamily: fonts.medium,
    color: colors.mutedForeground,
  },

  // ── Grid ──
  gridRow: {
    paddingHorizontal: 12,
    gap: 8,
    marginBottom: 8,
  },
  gridCell: {
    flex: 1,
  },

  // ── Empty state ──
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 60,
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

  // ── Sticky View Indent bar ──
  stickyWrap: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 12,
    paddingBottom: 10,
    backgroundColor: "transparent",
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