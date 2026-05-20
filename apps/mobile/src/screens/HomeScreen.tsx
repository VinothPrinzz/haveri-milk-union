import React, { useMemo, useState } from "react";
import {
  RefreshControl,
  ScrollView,
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

/**
 * HomeScreen v2 — the Blinkit-style product showcase.
 *
 * Changes from v1:
 *   • No more 3-way window-state branching. Home is ALWAYS browseable
 *     — the date pill at the top tells the dealer what date their
 *     adds are flowing into. When today's window closes, the
 *     targetDate store auto-advances to tomorrow so + still works.
 *   • Reorder strip, repeat-yesterday card, WindowClosedContent and
 *     ClosingSoonBanner all moved to the Indent tab. Home is now
 *     pure product discovery.
 *   • AppHeader replaces DealerHeader — gives every tab the
 *     bell + profile-avatar pattern.
 *   • Products grid uses the new Blinkit-style ProductCard. Existing
 *     `CategoryBar` (horizontal pill scroll) stays as a quick filter
 *     for in-place browsing; the Categories tab handles deep
 *     navigation.
 *
 * Layout (top-to-bottom):
 *   1. AppHeader (dealer name + zone, bell, avatar)
 *   2. DatePill ("Adding to: Today · 1h 23m left")
 *   3. Search bar
 *   4. PromoBanner strip (only when banners exist)
 *   5. CategoryBar (horizontal pills, "All" first)
 *   6. Products grid (2 col)
 *   7. Sticky "View indent" bar (when items in draft)
 */

interface HomeScreenProps {
  /** Called when the user taps the sticky View Indent bar */
  onOpenIndent: () => void;
  /** Called when the user taps the date pill — usually switches to Indent tab */
  onOpenIndentForDate: () => void;
  /** Called when the user taps the bell icon */
  onOpenNotifications: () => void;
  /** Called when the user taps the profile avatar */
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

  // ── Target date store (so + adds to the right day's draft) ──────
  const advanceIfWindowClosed = useTargetDateStore((s) => s.advanceIfWindowClosed);

  // ── API ─────────────────────────────────────────────────────────
  const windowQuery = useWindowStatus(dealer?.zoneId);
  const productsQuery = useProducts();
  const catsQuery = useCategories();
  const bannersQuery = useBanners();
  const { data: notifs } = useNotifications();

  // ── Local state ─────────────────────────────────────────────────
  const [search, setSearch] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>(ALL_CATEGORY_ID);
  const [refreshing, setRefreshing] = useState(false);

  // Auto-advance to tomorrow when today's window closes
  // (no-op if dealer has manually picked a future date).
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
      if (selectedCategoryId !== ALL_CATEGORY_ID && p.categoryId !== selectedCategoryId) {
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

  // ── Render ──────────────────────────────────────────────────────
  if (!dealer) return null;

  return (
    <View style={styles.root}>
      <AppHeader
        unreadNotifications={unreadNotifications}
        onBellPress={onOpenNotifications}
        onProfilePress={onOpenProfile}
      />

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.scrollContent,
          { paddingBottom: cartItemCount > 0 ? 100 : 24 },
        ]}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={colors.primary}
          />
        }
      >
        <DatePill
          windowStatus={windowQuery.data ?? null}
          onPress={onOpenIndentForDate}
        />

        {/* Search bar */}
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

        {/* Banners */}
        {bannerItems.length > 0 && <PromoBanner items={bannerItems} />}

        {/* Category quick-filter pills */}
        {categoryItems.length > 0 && (
          <CategoryBar
            categories={categoryItems}
            selectedId={selectedCategoryId}
            onSelect={setSelectedCategoryId}
          />
        )}

        {/* Section header */}
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>
            {selectedCategoryId === ALL_CATEGORY_ID
              ? "All products"
              : categoryItems.find((c) => c.id === selectedCategoryId)?.name ??
                "Products"}
          </Text>
          <Text style={styles.sectionMeta}>
            {filteredProducts.length} item{filteredProducts.length === 1 ? "" : "s"}
          </Text>
        </View>

        {/* Grid or empty state */}
        {filteredProducts.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyEmoji}>🔎</Text>
            <Text style={styles.emptyTitle}>No products found</Text>
            <Text style={styles.emptySub}>
              {search ? `No matches for "${search}"` : "Try another category"}
            </Text>
          </View>
        ) : (
          <View style={styles.grid}>
            {filteredProducts.map((p) => (
              <View key={p.id} style={styles.gridCell}>
                <ProductCard
                  product={p}
                  quantity={cartItems[p.id]?.quantity ?? 0}
                  onAdd={() => addItem(toCartProduct(p))}
                  onRemove={() => removeItem(p.id)}
                />
              </View>
            ))}
          </View>
        )}
      </ScrollView>

      {/* Sticky View Indent bar */}
      {cartItemCount > 0 && (
        <View style={styles.stickyWrap}>
          <TouchableOpacity
            activeOpacity={0.85}
            onPress={onOpenIndent}
            style={styles.stickyBar}
            accessibilityRole="button"
            accessibilityLabel={`View indent, ${cartItemCount} items, ₹${cartGrand.toFixed(2)}`}
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
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: 24 },

  // ── Search ──
  searchWrap: {
    paddingHorizontal: 12,
    paddingTop: 10,
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
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    paddingHorizontal: 12,
    gap: 8,
  },
  gridCell: {
    width: "48.5%",
  },

  // ── Empty state ──
  empty: {
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
  stickyInfo: {
    flex: 1,
  },
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