import React, { useState } from "react";
import {
  Image,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { colors, fonts, shadows } from "../lib/theme";
import type { Product } from "../lib/types";

/**
 * ProductCard — the core 2-col-grid product tile (spec §6.7).
 *
 * Mockup CSS (dealer-app.html lines 178-198):
 *   .product-card { bg:#FFFFFF; border-radius:14px; padding:11px; shadow-sm;
 *                   border:1.5px solid transparent; position:relative }
 *   .pc-badge     { top:8px left:8px; font-size:7px; weight:800; padding:2px 6px;
 *                   border-radius:3px; uppercase; letter-spacing:0.4px }
 *       .new   { bg #FEF3C7; color amber }
 *       .offer { bg #DCFCE7; color green }
 *       .low   { bg #FEE2E2; color red }
 *   .pc-stock     { top:8px right:8px; 6×6 circle }
 *       .in  green | .low amber | .out red
 *   .pc-img       { font-size:36px; text-align:center; margin:18px 0 7px }
 *   .pc-name      { font-size:11px; weight:700; line-height:1.3 }
 *   .pc-size      { font-size:9px; color ink3; weight:500; margin-top:2px }
 *   .pc-price-row { align-items:baseline; gap:3px; margin-top:5px }
 *   .pc-price     { font-size:14px; weight:800; font-family:Unbounded }
 *   .pc-unit      { font-size:8px; color ink3; weight:600 }
 *   .pc-gst       { font-size:8px; color ink3; weight:500; margin-top:1px }
 *   .pc-add       { bg brand; color white; border-radius:7px; padding:7px; font-size:10px;
 *                   weight:800; margin-top:7px }
 *   .pc-qty       { bg brand-l; border:1.5px solid brand-l2; border-radius:7px; margin-top:7px }
 *       .pc-q-btn  { w:27 h:29; color brand; font-size:16px; weight:900 }
 *       .pc-q-val  { flex:1; text-align:center; font-size:13px; weight:800; color brand }
 *
 * Backend note:
 *   The /products endpoint returns an `icon` (emoji) field but no `imageUrl` yet.
 *   This card accepts both — prefers imageUrl when present with a lazy-load skeleton,
 *   falls back to the emoji (or 📦 if neither is provided) on error or absence.
 */

interface ProductCardProps {
  product: Product;
  /** Current quantity in cart — drives add-button vs stepper rendering */
  quantity: number;
  /** "Out of Stock" is shown when !product.available || product.stock === 0 */
  lowStockThreshold?: number;   // default 10 — matches backend typical
  onAdd: () => void;
  onRemove: () => void;
  /** Explicit badge override; otherwise derived from stock + availability */
  badge?: { kind: "new" | "offer" | "low"; label: string };
}

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
  const lowStock   = !outOfStock && product.stock <= lowStockThreshold;

  // Derive stock dot color
  const stockColor =
    outOfStock ? colors.destructive :
    lowStock   ? colors.warning :
                 colors.success;

  // Derive badge if not explicitly set
  const resolvedBadge =
    badge ??
    (lowStock ? { kind: "low" as const, label: "Low Stock" } : undefined);

  // ── Image / emoji resolution ────────────────────────────────────────
  const hasImage = !!product.imageUrl && !imageError;
  const fallbackEmoji = product.icon ?? "📦";

  // ── Price formatting ────────────────────────────────────────────────
  const priceStr = Number.isInteger(product.basePrice)
    ? String(product.basePrice)
    : product.basePrice.toFixed(2);

  // ── GST label ───────────────────────────────────────────────────────
  const gstStr = Number.isInteger(product.gstPercent)
    ? String(product.gstPercent)
    : product.gstPercent.toFixed(1);

  return (
    <View style={styles.card}>
      {/* Top-left badge */}
      {resolvedBadge && (
        <View style={[styles.badge, BADGE_STYLES[resolvedBadge.kind]]}>
          <Text style={[styles.badgeText, BADGE_TEXT_STYLES[resolvedBadge.kind]]}>
            {resolvedBadge.label}
          </Text>
        </View>
      )}

      {/* Top-right stock dot */}
      <View style={[styles.stockDot, { backgroundColor: stockColor }]} />

      {/* Image / emoji */}
      <View style={styles.imageWrap}>
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
      </View>

      {/* Name + unit */}
      <Text style={styles.name} numberOfLines={2}>{product.name}</Text>
      <Text style={styles.unit}>{product.unit}</Text>

      {/* Price row */}
      <View style={styles.priceRow}>
        <Text style={styles.price}>₹{priceStr}</Text>
        <Text style={styles.priceUnit}>/pc</Text>
      </View>
      <Text style={styles.gst}>Incl. GST {gstStr}%</Text>

      {/* Add button OR quantity stepper */}
      {quantity === 0 ? (
        <TouchableOpacity
          onPress={onAdd}
          disabled={outOfStock}
          activeOpacity={0.8}
          style={[styles.addBtn, outOfStock && styles.addBtnDisabled]}
          accessibilityRole="button"
          accessibilityState={{ disabled: outOfStock }}
        >
          <Text style={styles.addBtnText}>
            {outOfStock ? "Out of Stock" : "+ Add to Indent"}
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
  );
}

// ════════════════════════════════════════════════════════════════════════
// Styles
// ════════════════════════════════════════════════════════════════════════

const styles = StyleSheet.create({
  card: {
    flex: 1,
    backgroundColor: colors.card,
    borderRadius: 14,              // mockup
    padding: 11,                   // mockup
    borderWidth: 1.5,
    borderColor: "transparent",
    position: "relative",
    ...shadows.sm,
  },

  badge: {
    position: "absolute",
    top: 8,                        // mockup
    left: 8,
    paddingVertical: 2,            // mockup
    paddingHorizontal: 6,
    borderRadius: 3,
    zIndex: 2,
  },
  badgeText: {
    fontSize: 7,                   // mockup
    fontFamily: fonts.extrabold,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },

  stockDot: {
    position: "absolute",
    top: 8,                        // mockup
    right: 8,
    width: 6,                      // mockup: 6×6
    height: 6,
    borderRadius: 3,
    zIndex: 2,
  },

  imageWrap: {
    marginTop: 18,                 // mockup: margin: 18px 0 7px
    marginBottom: 7,
    alignItems: "center",
    justifyContent: "center",
    height: 60,
  },
  emoji: {
    fontSize: 36,                  // mockup
    textAlign: "center",
  },
  image: {
    width: "100%",
    height: 60,
  },

  name: {
    fontSize: 11,                  // mockup
    fontFamily: fonts.bold,
    color: colors.foreground,
    lineHeight: 14.3,              // 11 × 1.3
  },
  unit: {
    fontSize: 9,                   // mockup
    fontFamily: fonts.medium,
    color: colors.mutedForeground,
    marginTop: 2,
  },

  priceRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 3,                        // mockup
    marginTop: 5,
  },
  price: {
    fontSize: 14,                  // mockup
    fontFamily: fonts.headingExtra,
    color: colors.foreground,
  },
  priceUnit: {
    fontSize: 8,                   // mockup
    fontFamily: fonts.semibold,
    color: colors.mutedForeground,
  },
  gst: {
    fontSize: 8,
    fontFamily: fonts.medium,
    color: colors.mutedForeground,
    marginTop: 1,
  },

  addBtn: {
    backgroundColor: colors.primary,
    borderRadius: 7,               // mockup
    paddingVertical: 7,
    alignItems: "center",
    marginTop: 7,
  },
  addBtnDisabled: {
    backgroundColor: colors.ink5,  // muted gray when out of stock
  },
  addBtnText: {
    fontSize: 10,                  // mockup
    fontFamily: fonts.extrabold,
    color: colors.primaryForeground,
  },

  stepper: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.primaryLight,
    borderRadius: 7,
    borderWidth: 1.5,
    borderColor: colors.primaryLight2,
    marginTop: 7,
    overflow: "hidden",
  },
  stepBtn: {
    width: 27,                     // mockup
    height: 29,
    alignItems: "center",
    justifyContent: "center",
  },
  stepIcon: {
    fontSize: 16,                  // mockup
    fontFamily: fonts.headingBlack,
    color: colors.primary,
    lineHeight: 18,
  },
  stepVal: {
    flex: 1,
    textAlign: "center",
    fontSize: 13,                  // mockup
    fontFamily: fonts.extrabold,
    color: colors.primary,
  },
});

// ── Badge kind → background/text styling ──────────────────────────────

const BADGE_STYLES = {
  new:   { backgroundColor: colors.warningLight },
  offer: { backgroundColor: colors.successLight },
  low:   { backgroundColor: colors.destructiveLight },
} as const;

const BADGE_TEXT_STYLES = {
  new:   { color: colors.warning },
  offer: { color: colors.success },
  low:   { color: colors.destructive },
} as const;