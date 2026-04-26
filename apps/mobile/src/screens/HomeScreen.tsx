import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors, fonts, shadows } from "../lib/theme";
// ── Components ─────────────────────────────────────────────────────
import DealerHeader from "../components/DealerHeader";
import ClosingSoonBanner from "../components/ClosingSoonBanner";
import WindowClosedContent from "../components/WindowClosedContent";
import PromoBanner, { type PromoBannerItem } from "../components/PromoBanner";
import CategoryBar, { type CategoryItem } from "../components/CategoryBar";
import ReorderStrip, { type ReorderItem } from "../components/ReorderStrip";
import ProductCard from "../components/ProductCard";
import LocationPicker, { type LocationOption } from "../components/LocationPicker";
// ── Hooks + stores ─────────────────────────────────────────────────
import { useAuthStore } from "../store/auth";
import { useCartStore } from "../store/cart";
import { useWindowStatus } from "../hooks/useWindow";
import { useProducts, useCategories } from "../hooks/useProducts";
import { useBanners } from "../hooks/useBanners";
import { useMyOrders } from "../hooks/useOrders";
import { useNotifications } from "../hooks/useNotifications";
import type { Product, Banner, WindowState } from "../lib/types";

/**
 * HomeScreen / DealerDashboard — the main dealer landing page.
 *
 * Branches into 3 layouts based on windowState:
 * • "open" → search + banners + categories + reorder + product grid + sticky cart
 * • "warning" → ClosingSoonBanner + reorder (amber) + Repeat-Yesterday card + product grid + amber sticky cart
 * • "closed" → WindowClosedContent (no products, no cart)
 *
 * The sticky cart button at the bottom hands off to props.onOpenCart() which
 * App.tsx wires to navigate to the CartScreen.
 *
 * Mockup CSS reference (dealer-app.html lines 132-136, 164-166, 201-206):
 * .search-bar : 999r card bg, 1.5px border, padding 10/14, gap 9, shadow-sm
 * .sec-hdr : flex space-between, padding 14/14/8
 * .sticky-cart : ink bg, 14r, padding 12/14, gap 11, shadow-lg, mx 12 mb 9
 * .sc-count : #FCD34D bg, 26x26 7r, ink color, 12/900
 * .sc-items : 9px 600 rgba(255,255,255,0.5)
 * .sc-total : 14px Unbounded ExtraBold white
 * .sc-cta : 11px 800 #FCD34D
 *
 * The closing-soon variant of sticky-cart uses bg #92400E (warningSolid).
 */
interface HomeScreenProps {
  /** Called when user taps the floating sticky cart bar. */
  onOpenCart: () => void;
  onOpenNotifications: () => void;
}

const ALL_CATEGORY_ID = "all";

export default function HomeScreen({ onOpenCart, onOpenNotifications }: HomeScreenProps) {
  const insets = useSafeAreaInsets();
  const dealer = useAuthStore((s) => s.dealer);
  const refreshProfile = useAuthStore((s) => s.refreshProfile);
  const patchDealer = useAuthStore((s) => s.patchDealer);
  // ── Cart subscriptions ─────────────────────────────────────────────
  const cartItems = useCartStore((s) => s.items);
  const cartItemCount = useCartStore((s) => s.getItemCount());
  const cartGrand = useCartStore((s) => s.getGrandTotal());
  const cartProducts = useCartStore((s) => s.getItems());
  const addItem = useCartStore((s) => s.addItem);
  const removeItem = useCartStore((s) => s.removeItem);
  // ── API ────────────────────────────────────────────────────────────
  const windowQuery = useWindowStatus(dealer?.zoneId);
  const productsQuery = useProducts();
  const catsQuery = useCategories();
  const bannersQuery = useBanners();
  const ordersQuery = useMyOrders({ page: 1, limit: 10 });
  const { data: notifs } = useNotifications();   // ← Added for unread count

  // ── Local state ────────────────────────────────────────────────────
  const [pickerOpen, setPickerOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>(ALL_CATEGORY_ID);
  const [refreshing, setRefreshing] = useState(false);

  // ── Derived: window state with safe defaults ───────────────────────
  const win = windowQuery.data;
  const windowState: WindowState = win?.state ?? "closed";
  const remainingSeconds = win?.remainingSeconds ?? 0;
  const openTime = win?.openTime ?? "06:00";
  const closeTime = win?.closeTime ?? "08:00";

  // ── Derived: nextOpenAt for the closed-state countdown ─────────────
  const nextOpenAt = useMemo(() => {
    const now = new Date();
    const [h, m] = openTime.split(":").map((s) => parseInt(s, 10));
    const target = new Date(now);
    target.setHours(h, m, 0, 0);
    if (target.getTime() <= now.getTime()) {
      target.setDate(target.getDate() + 1);
    }
    return target;
  }, [openTime, win?.serverTime]);

  // ── Derived: filtered products ─────────────────────────────────────
  const products = productsQuery.data ?? [];
  const filteredProducts = useMemo(() => {
    let list = products;
    if (selectedCategoryId !== ALL_CATEGORY_ID) {
      list = list.filter((p) => p.categoryId === selectedCategoryId);
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter((p) => p.name.toLowerCase().includes(q));
    }
    return list;
  }, [products, selectedCategoryId, search]);

  // ── Derived: categories for the bar ────────────────────────────────
  const categoryItems: CategoryItem[] = useMemo(
    () =>
      (catsQuery.data ?? []).map((c) => ({
        id: c.id,
        name: c.name,
        icon: c.icon ?? "📦",
      })),
    [catsQuery.data]
  );

  // ── Derived: banner items mapped from API ──────────────────────────
  const bannerItems: PromoBannerItem[] = useMemo(
    () => (bannersQuery.data ?? []).map(mapBannerToItem),
    [bannersQuery.data]
  );

  // ── Derived: reorder items from past orders ────────────────────────
  const reorderItems: ReorderItem[] = useMemo(() => {
    const orders = ordersQuery.data?.data ?? [];
    if (orders.length === 0) return [];
    const productAgg = new Map<string, ReorderItem>();
    for (const order of orders.slice(0, 5)) {
      for (const item of order.items) {
        if (!item.productId) continue;
        const existing = productAgg.get(item.productId);
        if (existing) {
          existing.lastQuantity = Math.max(existing.lastQuantity, item.quantity);
        } else {
          const product = products.find((p) => p.id === item.productId);
          productAgg.set(item.productId, {
            productId: item.productId,
            name: item.productName,
            emoji: product?.icon ?? "📦",
            lastQuantity: item.quantity,
          });
        }
      }
    }
    return Array.from(productAgg.values()).slice(0, 6);
  }, [ordersQuery.data, products]);

  // ── Derived: today's orders for the closed-state activity card ─────
  const todaysOrders = useMemo(() => {
    const orders = ordersQuery.data?.data ?? [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return orders.filter((o) => {
      const d = new Date(o.createdAt);
      return d.getTime() >= today.getTime();
    });
  }, [ordersQuery.data]);

  // ── Locations (for the LocationPicker) ─────────────────────────────
  const locationOptions: LocationOption[] = useMemo(() => {
    if (!dealer) return [];
    return [
      {
        id: dealer.zoneId,
        name: dealer.locationLabel ?? dealer.zoneName ?? "Your Location",
        emoji: "🏪",
        sublabel: dealer.zoneName ?? "Delivery Zone",
      },
    ];
  }, [dealer]);

  // ── Pull-to-refresh ────────────────────────────────────────────────
  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await Promise.all([
        refreshProfile(),
        windowQuery.refetch(),
        productsQuery.refetch(),
        catsQuery.refetch(),
        bannersQuery.refetch(),
        ordersQuery.refetch(),
      ]);
    } finally {
      setRefreshing(false);
    }
  };

  // ── Repeat Yesterday's Order: aggregate from latest order ──────────
  const repeatableOrder = useMemo(() => {
    const orders = ordersQuery.data?.data ?? [];
    return orders[0];
  }, [ordersQuery.data]);

  const handleRepeatOrder = () => {
    if (!repeatableOrder) return;
    for (const item of repeatableOrder.items) {
      if (!item.productId) continue;
      const product = products.find((p) => p.id === item.productId);
      if (!product || !product.available || product.stock < item.quantity) continue;
      for (let i = 0; i < item.quantity; i++) {
        addItem({
          id: product.id,
          name: product.name,
          icon: product.icon ?? "📦",
          unit: product.unit,
          basePrice: product.basePrice,
          gstPercent: product.gstPercent,
        });
      }
    }
  };

  // ── ReorderStrip add handler ───────────────────────────────────────
  const handleReorderAdd = (reorderItem: ReorderItem) => {
    const product = products.find((p) => p.id === reorderItem.productId);
    if (!product || !product.available || product.stock === 0) return;
    addItem({
      id: product.id,
      name: product.name,
      icon: product.icon ?? "📦",
      unit: product.unit,
      basePrice: product.basePrice,
      gstPercent: product.gstPercent,
    });
  };

  // ── Unread notifications ───────────────────────────────────────────
  const hasUnread = (notifs ?? []).some((n: any) => n.unread);

  // ── Loading overlay (first load only) ──────────────────────────────
  const isFirstLoad =
    (productsQuery.isLoading || windowQuery.isLoading) &&
    !productsQuery.data && !windowQuery.data;

  if (isFirstLoad) {
    return (
      <View style={styles.firstLoad}>
        <ActivityIndicator color={colors.primary} size="large" />
        <Text style={styles.firstLoadText}>Loading dashboard…</Text>
      </View>
    );
  }

  if (!dealer) {
    return null;
  }

  // ── Render ─────────────────────────────────────────────────────────
  return (
    <View style={styles.root}>
      <DealerHeader
        dealerName={dealer.name}
        locationLabel={dealer.locationLabel ?? dealer.zoneName ?? "Your Location"}
        windowState={windowState}
        remainingSeconds={remainingSeconds}
        openTime={openTime}
        closeTime={closeTime}
        hasNotification={hasUnread}
        onLocationPress={() => setPickerOpen(true)}
        onNotificationPress={onOpenNotifications}
      />

      {/* Body: 3 branches by windowState */}
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.scrollContent,
          {
            paddingBottom:
              windowState === "closed" ? 24 : (cartItemCount > 0 ? 110 : 24),
          },
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
        {windowState === "closed" ? (
          // ── CLOSED LAYOUT ──
          <WindowClosedContent
            nextOpenAt={nextOpenAt}
            openTime={formatAmPm(openTime)}
            closeTime={formatAmPm(closeTime)}
            todaysOrders={todaysOrders}
            notificationsEnabled={dealer.notificationsEnabled ?? false}
            onNotificationsChange={(v) =>
              patchDealer({ notificationsEnabled: v })
            }
            onViewAllOrders={() => {/* App-level tab switch handled separately */}}
          />
        ) : (
          // ── OPEN / WARNING LAYOUT ──
          <>
            {/* Closing-soon banner only on warning */}
            {windowState === "warning" && (
              <ClosingSoonBanner
                minutesLeft={Math.ceil(remainingSeconds / 60)}
                openTimeNextDay={`tomorrow ${formatAmPm(openTime)}`}
              />
            )}

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
                  placeholderTextColor={colors.ink4}
                  returnKeyType="search"
                />
                {search ? (
                  <TouchableOpacity onPress={() => setSearch("")} activeOpacity={0.7}>
                    <Text style={styles.searchClear}>✕</Text>
                  </TouchableOpacity>
                ) : (
                  <View style={styles.searchFilter}>
                    <Text style={styles.searchFilterText}>Filter</Text>
                  </View>
                )}
              </View>
            </View>

            {/* Promo banners (open state only — warning state hides them per mockup) */}
            {windowState === "open" && bannerItems.length > 0 && (
              <PromoBanner items={bannerItems} />
            )}

            {/* Category pills (only in open state) */}
            {windowState === "open" && categoryItems.length > 0 && (
              <CategoryBar
                categories={categoryItems}
                selectedId={selectedCategoryId}
                onSelect={setSelectedCategoryId}
              />
            )}

            {/* Reorder strip */}
            {reorderItems.length > 0 && (
              <>
                <SectionHeader
                  title={
                    windowState === "warning" ? "🔄 Quick Reorder" : "🔄 Order Again"
                  }
                  link={windowState === "warning" ? "Save time!" : "See all"}
                  linkColor={
                    windowState === "warning" ? colors.warning : colors.primary
                  }
                  topMargin={windowState === "warning" ? 9 : 0}
                />
                <ReorderStrip
                  items={reorderItems}
                  onAdd={handleReorderAdd}
                  accent={windowState === "warning" ? "warning" : "primary"}
                />
              </>
            )}

            {/* Repeat Yesterday's Order — warning state only (mockup screen 04) */}
            {windowState === "warning" && repeatableOrder && (
              <RepeatYesterdayCard
                itemSummary={summarizeOrderItems(repeatableOrder.items)}
                total={repeatableOrder.grandTotal}
                onAddAll={handleRepeatOrder}
              />
            )}

            {/* Products grid */}
            <SectionHeader
              title={windowState === "warning" ? "Products" : "Today's Products"}
              link={
                windowState === "warning"
                  ? undefined
                  : `${filteredProducts.length} items`
              }
              topMargin={windowState === "warning" ? 9 : 3}
            />

            {filteredProducts.length === 0 ? (
              <View style={styles.emptyProducts}>
                <Text style={styles.emptyProductsEmoji}>🔎</Text>
                <Text style={styles.emptyProductsTitle}>No products found</Text>
                <Text style={styles.emptyProductsSub}>
                  {search
                    ? `No matches for "${search}"`
                    : "Try a different category"}
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
          </>
        )}
      </ScrollView>

      {/* Sticky cart — only when window is open/warning AND cart has items */}
      {windowState !== "closed" && cartItemCount > 0 && (
        <StickyCart
          itemCount={cartItemCount}
          productCount={cartProducts.length}
          total={cartGrand}
          warning={windowState === "warning"}
          onPress={onOpenCart}
        />
      )}

      {/* Location picker modal */}
      <LocationPicker
        visible={pickerOpen}
        selected={dealer.zoneId}
        locations={locationOptions}
        onSelect={() => {}}
        onClose={() => setPickerOpen(false)}
      />
    </View>
  );
}

// ════════════════════════════════════════════════════════════════════════
// SectionHeader, RepeatYesterdayCard, StickyCart, and all helper functions
// remain unchanged below...
// (All other code stays exactly the same)

// ════════════════════════════════════════════════════════════════════════
// SectionHeader — used 2-3 times in the dashboard
// ════════════════════════════════════════════════════════════════════════

interface SectionHeaderProps {
  title: string;
  link?: string;
  linkColor?: string;
  topMargin?: number;
}

function SectionHeader({
  title,
  link,
  linkColor = colors.primary,
  topMargin = 0,
}: SectionHeaderProps) {
  return (
    <View style={[styles.secHdr, { marginTop: topMargin }]}>
      <Text style={styles.secHdrTitle}>{title}</Text>
      {link && (
        <Text style={[styles.secHdrLink, { color: linkColor }]}>{link}</Text>
      )}
    </View>
  );
}

// ════════════════════════════════════════════════════════════════════════
// RepeatYesterdayCard — only shown in window-closing state (mockup screen 04)
// ════════════════════════════════════════════════════════════════════════

interface RepeatYesterdayCardProps {
  itemSummary: string;
  total: number;
  onAddAll: () => void;
}

function RepeatYesterdayCard({
  itemSummary,
  total,
  onAddAll,
}: RepeatYesterdayCardProps) {
  return (
    <View style={styles.repeatCard}>
      <Text style={styles.repeatTitle}>↻ Repeat Yesterday's Order</Text>
      <Text style={styles.repeatSummary}>
        {itemSummary} · ₹ {total.toFixed(2)}
      </Text>
      <TouchableOpacity
        style={styles.repeatBtn}
        activeOpacity={0.85}
        onPress={onAddAll}
      >
        <Text style={styles.repeatBtnText}>Add All to Indent →</Text>
      </TouchableOpacity>
    </View>
  );
}

// ════════════════════════════════════════════════════════════════════════
// StickyCart — floating bottom button (open + warning states)
// ════════════════════════════════════════════════════════════════════════

interface StickyCartProps {
  itemCount: number;
  productCount: number;
  total: number;
  warning: boolean;
  onPress: () => void;
}

function StickyCart({
  itemCount,
  productCount,
  total,
  warning,
  onPress,
}: StickyCartProps) {
  const insets = useSafeAreaInsets();

  return (
    <View
      style={[
        stickyCartStyles.wrap,
        { bottom: Math.max(insets.bottom + 9, 9) },
      ]}
      pointerEvents="box-none"
    >
      <TouchableOpacity
        activeOpacity={0.85}
        onPress={onPress}
        style={[
          stickyCartStyles.cart,
          warning && { backgroundColor: colors.windowWarningSolid },
        ]}
        accessibilityRole="button"
        accessibilityLabel={`Open cart with ${itemCount} items, total ${total.toFixed(2)}`}
      >
        <View style={stickyCartStyles.count}>
          <Text style={stickyCartStyles.countText}>{itemCount}</Text>
        </View>
        <View style={stickyCartStyles.info}>
          <Text style={stickyCartStyles.items}>
            {warning ? `${itemCount} items · Hurry!` : `${itemCount} items · ${productCount} products`}
          </Text>
          <Text style={stickyCartStyles.total}>₹ {total.toFixed(2)}</Text>
        </View>
        <Text style={stickyCartStyles.cta}>
          {warning ? "Pay Now ⚡" : "Review Indent →"}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

// ════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════

/** Format "06:00" or "08:00" → "6:00 AM" / "8:00 AM" */
function formatAmPm(hhmm: string): string {
  const [h, m] = hhmm.split(":").map((s) => parseInt(s, 10));
  if (Number.isNaN(h)) return hhmm;
  const ampm = h >= 12 ? "PM" : "AM";
  const display = h % 12 || 12;
  return `${display}:${String(m).padStart(2, "0")} ${ampm}`;
}

/** Map an API banner to the PromoBanner item shape, choosing a variant by category. */
function mapBannerToItem(b: Banner): PromoBannerItem {
  // Heuristic: cycle by index on the category for stable but varied colors.
  const cat = (b.category ?? "").toLowerCase();
  let variant: PromoBannerItem["variant"] = "brand";
  if (cat.includes("offer") || cat.includes("discount")) variant = "amber";
  else if (cat.includes("new") || cat.includes("launch")) variant = "green";

  // Title can have a newline embedded
  return {
    id: b.id,
    variant,
    emoji: emojiForBannerCategory(cat),
    sub: b.category ?? "Announcement",
    title: b.title,
    badge: b.subtitle ?? undefined,
  };
}

function emojiForBannerCategory(cat: string): string {
  if (cat.includes("offer") || cat.includes("discount")) return "🎉";
  if (cat.includes("new") || cat.includes("launch")) return "🧈";
  if (cat.includes("notice") || cat.includes("announcement")) return "📢";
  return "📦";
}

/** Summarize order items as e.g. "15× Milk + 4× Butter + 8× Curd" */
function summarizeOrderItems(items: { productName: string; quantity: number }[]): string {
  return items
    .slice(0, 3)
    .map((i) => {
      // Trim long names — first word usually conveys the product
      const short = i.productName.split(/[\s,]+/).slice(0, 2).join(" ");
      return `${i.quantity}× ${short}`;
    })
    .join(" + ");
}

/** Convert a Product (API shape) to the CartProduct shape that cart.addItem expects. */
function toCartProduct(p: Product) {
  return {
    id: p.id,
    name: p.name,
    icon: p.icon ?? "📦",
    unit: p.unit,
    basePrice: p.basePrice,
    gstPercent: p.gstPercent,
  };
}

// ════════════════════════════════════════════════════════════════════════
// Styles
// ════════════════════════════════════════════════════════════════════════

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
  },
  firstLoad: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.background,
    gap: 12,
  },
  firstLoadText: {
    fontFamily: fonts.medium,
    color: colors.mutedForeground,
    fontSize: 12,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingTop: 0,
  },

  // Search ----------------------------------------------------------
  searchWrap: {
    paddingTop: 11,                         // mockup
    paddingHorizontal: 14,
  },
  searchBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    backgroundColor: colors.card,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: 999,
    paddingVertical: 10,
    paddingHorizontal: 14,
    ...shadows.sm,
  },
  searchIcon: {
    fontSize: 14,
    color: colors.ink4,
  },
  searchInput: {
    flex: 1,
    fontSize: 12,
    fontFamily: fonts.medium,
    color: colors.foreground,
    padding: 0,
  },
  searchClear: {
    fontSize: 12,
    fontFamily: fonts.bold,
    color: colors.ink4,
    paddingHorizontal: 4,
  },
  searchFilter: {
    backgroundColor: colors.primaryLight,
    paddingVertical: 3,
    paddingHorizontal: 9,
    borderRadius: 999,
  },
  searchFilterText: {
    fontSize: 11,
    fontFamily: fonts.bold,
    color: colors.primary,
  },

  // Section header --------------------------------------------------
  secHdr: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingTop: 14,
    paddingHorizontal: 14,
    paddingBottom: 8,
  },
  secHdrTitle: {
    fontSize: 13,
    fontFamily: fonts.extrabold,
    color: colors.foreground,
  },
  secHdrLink: {
    fontSize: 10,
    fontFamily: fonts.bold,
  },

  // Repeat Yesterday card -------------------------------------------
  repeatCard: {
    backgroundColor: colors.card,
    borderRadius: 14,
    padding: 12,
    marginTop: 9,
    marginHorizontal: 12,
    borderWidth: 1.5,
    borderColor: colors.warningLight,
    ...shadows.sm,
  },
  repeatTitle: {
    fontSize: 11,
    fontFamily: fonts.extrabold,
    color: colors.foreground,
    marginBottom: 7,
  },
  repeatSummary: {
    fontSize: 10,
    fontFamily: fonts.medium,
    color: colors.mutedForeground,
    marginBottom: 10,
  },
  repeatBtn: {
    backgroundColor: colors.warning,
    borderRadius: 11,
    paddingVertical: 10,
    alignItems: "center",
  },
  repeatBtnText: {
    fontSize: 11,
    fontFamily: fonts.extrabold,
    color: colors.primaryForeground,
  },

  // Empty products --------------------------------------------------
  emptyProducts: {
    alignItems: "center",
    paddingVertical: 48,
    paddingHorizontal: 24,
  },
  emptyProductsEmoji: {
    fontSize: 40,
    marginBottom: 8,
  },
  emptyProductsTitle: {
    fontSize: 14,
    fontFamily: fonts.extrabold,
    color: colors.foreground,
  },
  emptyProductsSub: {
    fontSize: 11,
    fontFamily: fonts.medium,
    color: colors.mutedForeground,
    marginTop: 4,
    textAlign: "center",
  },

  // Product grid ----------------------------------------------------
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    paddingHorizontal: 14,
    gap: 9,
    paddingBottom: 14,
  },
  gridCell: {
    width: "48.6%",                         // fits 2 columns with the 9-gap on a 380-ish viewport
  },
});

const stickyCartStyles = StyleSheet.create({
  wrap: {
    position: "absolute",
    left: 0,
    right: 0,
  },
  cart: {
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    backgroundColor: colors.foreground,     // mockup: var(--ink) = #0D1B2A
    marginHorizontal: 12,
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 14,
    ...shadows.lg,
  },
  count: {
    minWidth: 26,
    height: 26,
    borderRadius: 7,
    backgroundColor: colors.yellowAccent,   // #FCD34D
    paddingHorizontal: 5,
    alignItems: "center",
    justifyContent: "center",
  },
  countText: {
    fontSize: 12,
    fontFamily: fonts.headingBlack,
    color: colors.foreground,
  },
  info: {
    flex: 1,
  },
  items: {
    fontSize: 9,
    fontFamily: fonts.semibold,
    color: "rgba(255,255,255,0.5)",
  },
  total: {
    fontSize: 14,
    fontFamily: fonts.headingExtra,
    color: colors.primaryForeground,
    marginTop: 1,
  },
  cta: {
    fontSize: 11,
    fontFamily: fonts.extrabold,
    color: colors.yellowAccent,
  },
});