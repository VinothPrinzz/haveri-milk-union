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
import { minQtyFor, snapQtyToMin } from "../lib/minOrderQty";
import { resolveDisplayPrice } from "../lib/ratePrice";
import { useAuthStore } from "../store/auth";
import QtyStepper from "./QtyStepper";

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
  /** Current quantity in cart — drives ADD button vs text-input rendering */
  quantity: number;
  /** Threshold below which low_stock visual treatment kicks in */
  lowStockThreshold?: number;
  onAdd: () => void;
  onRemove: () => void;
  /**
   * Absolute-quantity setter — lets the dealer type a quantity directly
   * (e.g. 100) instead of tapping +. When provided, the stepper's value
   * becomes an editable input. Falls back to onAdd/onRemove if omitted.
   */
  onSetQuantity?: (qty: number) => void;
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
  onSetQuantity,
  badge,
}: ProductCardProps) {
  const [imageError, setImageError] = useState(false);
  // The dealer's rate category decides which price this card prints.
  const dealer = useAuthStore((s) => s.dealer);

  const outOfStock = !product.available || product.stock === 0;
  const lowStock = !outOfStock && product.stock <= lowStockThreshold;

  const hasImage = !!product.imageUrl && !imageError;
  const fallbackEmoji = product.icon ?? "📦";

  // Price display: dealers see the gross price they're billed at, resolved
  // for their rate category — a 'Credit Inst-MRP' dealer sees MRP on milk.
  // For every other dealer this is the Dealer-Price exactly as before.
  // Whole rupees get no decimals; fractional show 2dp.
  const rawPrice = resolveDisplayPrice(product, dealer?.rateCategory);
  const displayedPrice = Number.isInteger(rawPrice)
    ? String(rawPrice)
    : rawPrice.toFixed(2);

  const imageTint = TINT_BY_CATEGORY[product.categoryName] ?? colors.background;

  // Milk/Curd carry a per-line minimum order quantity (6). ADD jumps
  // straight to the minimum, and the stepper snaps 1–5 back up to it.
  const minQty = minQtyFor(product.categoryName);
  const hasMinQty = minQty > 1;

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

        {/* Price + ADD/stepper row */}
        <View style={styles.bottomRow}>
          <View style={styles.priceCol}>
            <Text style={styles.price}>₹{displayedPrice}</Text>
            {hasMinQty && (
              <Text style={styles.minQtyHint}>Min {minQty}</Text>
            )}
          </View>

          {quantity === 0 ? (
            <TouchableOpacity
              onPress={() =>
                hasMinQty && onSetQuantity ? onSetQuantity(minQty) : onAdd()
              }
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
            <QtyStepper
              value={quantity}
              max={product.stock}
              onSet={(q) => {
                // Snap 1–5 up to the Milk/Curd minimum; 0 still removes.
                const next = snapQtyToMin(q, product.categoryName);
                if (onSetQuantity) onSetQuantity(next);
                else if (next > quantity) onAdd();
                else onRemove();
              }}
              accessibilityLabel={`quantity for ${product.name}`}
            />
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
  minQtyHint: {
    fontSize: 9,
    fontFamily: fonts.bold,
    color: colors.mutedForeground,
    marginTop: 1,
    textTransform: "uppercase",
    letterSpacing: 0.3,
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