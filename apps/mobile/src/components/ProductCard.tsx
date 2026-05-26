import React, { useState } from "react";
import {
  Image,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { colors, fonts } from "../lib/theme";
import type { Product } from "../lib/types";

/**
 * ProductCard — Blinkit-style 2-col grid tile.
 *
 * Redesign brief (matches the dealer-app-v2 spec):
 *   • Minimal rounded corners — 6px on the card, 4px on buttons.
 *   • Image-led layout — image sits in a tinted block at the top of
 *     the card (Blinkit's signature). Falls back to the legacy emoji
 *     icon when product.imageUrl is absent.
 *   • Flat surfaces — single 0.5px border, no shadow. The whole grid
 *     feels denser and less "card-shaped".
 *   • Compact text block — name (2 lines), unit, then a single row at
 *     the bottom with price (left) and ADD button (right). The ADD
 *     button is OUTLINED, not solid, so it doesn't dominate the tile.
 *   • Quantity stepper replaces the ADD button in-place (same width)
 *     when quantity > 0, with a solid primary fill — classic Blinkit
 *     "added to cart" state.
 *
 * Props are IDENTICAL to the previous ProductCard — this is a
 * drop-in replacement. HomeScreen does not need to change.
 *
 * Notes:
 *   • `product.imageUrl` is now populated from the DB (migration 0029
 *     added the column). When the admin uploads an image, the next
 *     /products fetch returns it; this card lazy-loads with the emoji
 *     fallback until the URL is available.
 *   • Out-of-stock state: the ADD button is replaced by a muted
 *     "Out of stock" label; image is dimmed.
 *   • Low-stock badge is opt-in via the `badge` prop (the grid no
 *     longer renders it automatically — moved that logic up to
 *     HomeScreen where it can be controlled per-merchandising-block).
 */

interface ProductCardProps {
  product: Product;
  /** Current quantity in cart — drives ADD button vs stepper rendering */
  quantity: number;
  /** Threshold below which low_stock visual treatment kicks in */
  lowStockThreshold?: number;
  onAdd: () => void;
  onRemove: () => void;
  /** Optional badge override (e.g. "New", "Offer"). Defaults to none. */
  badge?: { kind: "new" | "offer" | "low"; label: string };
}

const TINT_BY_CATEGORY: Record<string, string> = {
  // Soft pastel backings for the image block, keyed by category name.
  // Categories not in this map fall back to colors.background.
  Milk: "#E6F1FB",
  Curd: "#FAEEDA",
  Buttermilk: "#EAF3DE",
  Lassi: "#FBEAF0",
  Ghee: "#FAEEDA",
  Paneer: "#F1EFE8",
  Sweets: "#FBEAF0",
  Beverages: "#E6F1FB",
};

export default function ProductCard({
  product,
  quantity,
  lowStockThreshold = 10,
  onAdd,
  onRemove,
  badge,
}: ProductCardProps) {
  const [imageError, setImageError] = useState(false);

  const outOfStock = !product.available || product.stock === 0;
  const lowStock = !outOfStock && product.stock <= lowStockThreshold;

  const hasImage = !!product.imageUrl && !imageError;
  const fallbackEmoji = product.icon ?? "📦";

  // Price display: prefer MRP, fall back to basePrice. Whole rupees
  // get no decimals; fractional show 2dp.
  const rawPrice = Number(product.mrp ?? product.basePrice ?? 0) || 0;
  const displayedPrice = Number.isInteger(rawPrice)
    ? String(rawPrice)
    : rawPrice.toFixed(2);

  const imageTint = TINT_BY_CATEGORY[product.categoryName] ?? colors.background;

  return (
    <View style={[styles.card, outOfStock && styles.cardDimmed]}>
      {/* Image block — full-width, tinted, takes the top of the card */}
      <View style={[styles.imageBlock, { backgroundColor: imageTint }]}>
        {hasImage ? (
          <Image
            source={{ uri: product.imageUrl! }}
            style={styles.image}
            resizeMode="contain"
            onError={() => setImageError(true)}
            accessibilityIgnoresInvertColors
          />
        ) : (
          <Text style={styles.emoji}>{fallbackEmoji}</Text>
        )}

        {/* Optional badge — top-left of image block */}
        {badge && (
          <View style={[styles.badge, BADGE_STYLES[badge.kind]]}>
            <Text style={[styles.badgeText, BADGE_TEXT_STYLES[badge.kind]]}>
              {badge.label}
            </Text>
          </View>
        )}

        {/* Low-stock subtle indicator — bottom-right of image, only when not OOS */}
        {lowStock && !badge && (
          <View style={styles.lowStockPill}>
            <Text style={styles.lowStockText}>Low stock</Text>
          </View>
        )}
      </View>

      {/* Text block */}
      <View style={styles.body}>
        <Text style={styles.name} numberOfLines={2}>
          {product.name}
        </Text>
        <Text style={styles.unit} numberOfLines={1}>
          {product.unit}
        </Text>

        {/* Price + ADD/stepper row */}
        <View style={styles.bottomRow}>
          <View style={styles.priceCol}>
            <Text style={styles.price}>₹{displayedPrice}</Text>
          </View>

          {quantity === 0 ? (
            <TouchableOpacity
              onPress={onAdd}
              disabled={outOfStock}
              activeOpacity={0.7}
              style={[styles.addBtn, outOfStock && styles.addBtnDisabled]}
              accessibilityRole="button"
              accessibilityState={{ disabled: outOfStock }}
            >
              <Text
                style={[
                  styles.addBtnText,
                  outOfStock && styles.addBtnTextDisabled,
                ]}
              >
                {outOfStock ? "Out" : "ADD"}
              </Text>
            </TouchableOpacity>
          ) : (
            <View style={styles.stepper}>
              <TouchableOpacity
                onPress={onRemove}
                activeOpacity={0.7}
                style={styles.stepBtn}
                accessibilityLabel="Decrease quantity"
              >
                <Text style={styles.stepIcon}>−</Text>
              </TouchableOpacity>
              <Text style={styles.stepVal}>{quantity}</Text>
              <TouchableOpacity
                onPress={onAdd}
                activeOpacity={0.7}
                style={styles.stepBtn}
                accessibilityLabel="Increase quantity"
              >
                <Text style={styles.stepIcon}>+</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      </View>
    </View>
  );
}

// ════════════════════════════════════════════════════════════════════════
// Styles — minimal radius, no shadow, flat surfaces
// ════════════════════════════════════════════════════════════════════════

const RADIUS = 6;
const BTN_RADIUS = 4;
const CARD_BORDER = colors.border ?? "#E5E7EB";

const styles = StyleSheet.create({
  card: {
    flex: 1,
    backgroundColor: colors.card,
    borderRadius: RADIUS,
    borderWidth: 0.5,
    borderColor: CARD_BORDER,
    overflow: "hidden",
  },
  cardDimmed: {
    opacity: 0.55,
  },

  // ── Image block ──
  imageBlock: {
    width: "100%",
    height: 150,        // was 112
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
  },
  image: {
    width: "100%",
    height: "100%",
  },
  emoji: {
    fontSize: 40,
    textAlign: "center",
  },

  // ── Badges ──
  badge: {
    position: "absolute",
    top: 6,
    left: 6,
    paddingVertical: 2,
    paddingHorizontal: 6,
    borderRadius: 2,
  },
  badgeText: {
    fontSize: 9,
    fontFamily: fonts.extrabold,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  lowStockPill: {
    position: "absolute",
    bottom: 6,
    right: 6,
    paddingVertical: 2,
    paddingHorizontal: 6,
    borderRadius: 2,
    backgroundColor: "rgba(217,119,6,0.12)",
  },
  lowStockText: {
    fontSize: 9,
    fontFamily: fonts.bold,
    color: "#92400E",
    textTransform: "uppercase",
    letterSpacing: 0.3,
  },

  // ── Body (text + bottom row) ──
  body: {
    padding: 10,
  },
  name: {
    fontSize: 12,
    fontFamily: fonts.semibold,
    color: colors.foreground,
    lineHeight: 16,
    minHeight: 32,
  },
  unit: {
    fontSize: 11,
    fontFamily: fonts.medium,
    color: colors.mutedForeground,
    marginTop: 3,
  },

  // ── Bottom row: price + ADD/stepper ──
  bottomRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 8,
  },
  priceCol: {
    flexShrink: 1,
    paddingRight: 6,
  },
  price: {
    fontSize: 14,
    fontFamily: fonts.bold,
    color: colors.foreground,
  },

  // ── ADD button (outlined) ──
  addBtn: {
    minWidth: 60,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: BTN_RADIUS,
    borderWidth: 1,
    borderColor: colors.primary,
    backgroundColor: colors.card,
    alignItems: "center",
    justifyContent: "center",
  },
  addBtnDisabled: {
    borderColor: colors.border ?? "#E5E7EB",
    backgroundColor: colors.card,
  },
  addBtnText: {
    fontSize: 12,
    fontFamily: fonts.extrabold,
    color: colors.primary,
    letterSpacing: 0.4,
  },
  addBtnTextDisabled: {
    color: colors.mutedForeground,
  },

  // ── Stepper (solid primary, replaces ADD when qty > 0) ──
  stepper: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.primary,
    borderRadius: BTN_RADIUS,
    overflow: "hidden",
    minWidth: 76,
  },
  stepBtn: {
    width: 24,
    height: 30,
    alignItems: "center",
    justifyContent: "center",
  },
  stepIcon: {
    fontSize: 18,
    fontFamily: fonts.bold,
    color: colors.primaryForeground,
    lineHeight: 20,
  },
  stepVal: {
    flex: 1,
    textAlign: "center",
    fontSize: 13,
    fontFamily: fonts.extrabold,
    color: colors.primaryForeground,
  },
});

// ── Badge color variants ──
const BADGE_STYLES = {
  new: { backgroundColor: "#FEF3C7" },
  offer: { backgroundColor: "#DCFCE7" },
  low: { backgroundColor: "#FEE2E2" },
} as const;

const BADGE_TEXT_STYLES = {
  new: { color: "#92400E" },
  offer: { color: "#166534" },
  low: { color: "#991B1B" },
} as const;