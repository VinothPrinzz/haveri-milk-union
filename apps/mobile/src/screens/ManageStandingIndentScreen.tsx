import React, { useMemo, useState, useEffect } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors, fonts } from "../lib/theme";
import {
  useEligibleProducts,
  useUpdateStandingIndent,
} from "../hooks/useStandingIndent";
import type { EligibleProduct } from "../lib/types";

/**
 * ManageStandingIndentScreen — configure the dealer's recurring template.
 *
 * Lists every product flagged `make_zero_in_indents=false` in the
 * admin catalog. Each row has:
 *   • Toggle (active flag — whether the product appears in the
 *     dealer's daily indent at all)
 *   • Quantity stepper (default_qty — how many of each)
 *
 * Edits are LOCAL until "Save changes" is tapped. Then a single PUT
 * upserts all rows.
 *
 * Why local-batch instead of save-on-every-change?
 *   Dealers will typically tune 5-10 products in a sitting. Sending
 *   a PUT per stepper tap would mean 50+ requests and laggy steppers.
 *   Batching is cheaper and the explicit Save button signals "this
 *   will change my daily order from tomorrow onwards" clearly.
 */

interface ManageStandingIndentScreenProps {
  onBack: () => void;
}

interface LocalEdit {
  productId: string;
  defaultQty: number;
  active: boolean;
}

function asMap(items: EligibleProduct[]): Map<string, LocalEdit> {
  const m = new Map<string, LocalEdit>();
  for (const it of items) {
    m.set(it.productId, {
      productId: it.productId,
      defaultQty: it.currentDefaultQty,
      active: it.currentActive,
    });
  }
  return m;
}

export default function ManageStandingIndentScreen({
  onBack,
}: ManageStandingIndentScreenProps) {
  const insets = useSafeAreaInsets();
  const eligibleQuery = useEligibleProducts();
  const updateMutation = useUpdateStandingIndent();

  const [search, setSearch] = useState("");
  const [edits, setEdits] = useState<Map<string, LocalEdit>>(new Map());

  // Seed local state from the server data once it loads
  useEffect(() => {
    if (eligibleQuery.data && edits.size === 0) {
      setEdits(asMap(eligibleQuery.data));
    }
  }, [eligibleQuery.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const products = eligibleQuery.data ?? [];

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return products;
    return products.filter((p) => p.productName.toLowerCase().includes(q));
  }, [products, search]);

  // Count edits vs server state
  const changedCount = useMemo(() => {
    let n = 0;
    for (const p of products) {
      const e = edits.get(p.productId);
      if (!e) continue;
      if (
        e.defaultQty !== p.currentDefaultQty ||
        e.active !== p.currentActive
      ) {
        n++;
      }
    }
    return n;
  }, [products, edits]);

  // ── Edit handlers ────────────────────────────────────────────────
  const updateRow = (productId: string, patch: Partial<LocalEdit>) => {
    setEdits((prev) => {
      const next = new Map(prev);
      const cur = next.get(productId) ?? {
        productId,
        defaultQty: 0,
        active: false,
      };
      next.set(productId, { ...cur, ...patch });
      return next;
    });
  };

  const handleQtyChange = (productId: string, delta: number) => {
    const cur = edits.get(productId);
    const newQty = Math.max(0, Math.min(10_000, (cur?.defaultQty ?? 0) + delta));
    // Auto-flip active=true when qty goes from 0 → positive
    const wasZero = (cur?.defaultQty ?? 0) === 0;
    const isPositive = newQty > 0;
    updateRow(productId, {
      defaultQty: newQty,
      ...(wasZero && isPositive ? { active: true } : {}),
    });
  };

  const handleActiveToggle = (productId: string, active: boolean) => {
    updateRow(productId, { active });
  };

  // ── Save ─────────────────────────────────────────────────────────
  const handleSave = async () => {
    if (changedCount === 0) return;
    // Send only rows that actually changed — avoids shipping the whole
    // catalog on every save, which was causing timeout on slow connections.
    const items = products
      .filter((p) => {
        const e = edits.get(p.productId);
        return (
          e !== undefined &&
          (e.defaultQty !== p.currentDefaultQty || e.active !== p.currentActive)
        );
      })
      .map((p) => {
        const e = edits.get(p.productId)!;
        return { productId: p.productId, defaultQty: e.defaultQty, active: e.active };
      });
    try {
      await updateMutation.mutateAsync(items);
      Alert.alert(
        "Standing indent saved",
        `Your daily defaults are updated. Tomorrow's indent will use the new values.`,
        [{ text: "OK", onPress: onBack }]
      );
    } catch (err) {
      Alert.alert(
        "Couldn't save",
        err instanceof Error ? err.message : "Please try again."
      );
    }
  };

  // ── Loading state ────────────────────────────────────────────────
  if (eligibleQuery.isLoading) {
    return (
      <View style={styles.root}>
        <Header onBack={onBack} insetsTop={insets.top} />
        <View style={styles.loading}>
          <ActivityIndicator color={colors.primary} />
        </View>
      </View>
    );
  }

  // ── Empty (no eligible products) ─────────────────────────────────
  if (products.length === 0) {
    return (
      <View style={styles.root}>
        <Header onBack={onBack} insetsTop={insets.top} />
        <View style={styles.empty}>
          <Text style={styles.emptyEmoji}>📋</Text>
          <Text style={styles.emptyTitle}>No products available</Text>
          <Text style={styles.emptySub}>
            Your union hasn't enabled any products for daily indents
            yet. Add items individually from the Home tab when needed.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <Header onBack={onBack} insetsTop={insets.top} />

      <View style={styles.subHeader}>
        <Text style={styles.subHeaderText}>
          Toggle and set quantities for products you order daily. These
          quantities apply automatically every day — you can still
          adjust any single day from the Indent tab.
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
            placeholder="Filter products…"
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

      <ScrollView
        style={styles.list}
        contentContainerStyle={[
          styles.listContent,
          { paddingBottom: changedCount > 0 ? 100 : 24 },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {filtered.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyEmoji}>🔎</Text>
            <Text style={styles.emptyTitle}>No matches</Text>
          </View>
        ) : (
          filtered.map((p) => {
            const edit = edits.get(p.productId) ?? {
              productId: p.productId,
              defaultQty: p.currentDefaultQty,
              active: p.currentActive,
            };
            const dirty =
              edit.defaultQty !== p.currentDefaultQty ||
              edit.active !== p.currentActive;
            return (
              <ProductRow
                key={p.productId}
                product={p}
                edit={edit}
                dirty={dirty}
                onActiveToggle={(v) => handleActiveToggle(p.productId, v)}
                onIncrement={() => handleQtyChange(p.productId, 1)}
                onDecrement={() => handleQtyChange(p.productId, -1)}
              />
            );
          })
        )}
      </ScrollView>

      {/* Sticky save bar */}
      {changedCount > 0 && (
        <View style={styles.stickyWrap}>
          <View style={styles.stickyBar}>
            <View style={styles.stickyInfo}>
              <Text style={styles.stickyCount}>{changedCount}</Text>
              <Text style={styles.stickyLabel}>
                change{changedCount === 1 ? "" : "s"} pending
              </Text>
            </View>
            <TouchableOpacity
              activeOpacity={0.85}
              disabled={updateMutation.isPending}
              onPress={handleSave}
              style={[
                styles.saveBtn,
                updateMutation.isPending && styles.saveBtnDisabled,
              ]}
            >
              {updateMutation.isPending ? (
                <ActivityIndicator color={colors.primaryForeground} />
              ) : (
                <Text style={styles.saveBtnText}>Save changes</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      )}
    </View>
  );
}

// ── Header (inline, with back) ──────────────────────────────────────
function Header({ onBack, insetsTop }: { onBack: () => void; insetsTop: number }) {
  return (
    <View style={[styles.header, { paddingTop: Math.max(insetsTop + 6, 38) }]}>
      <TouchableOpacity
        onPress={onBack}
        activeOpacity={0.6}
        hitSlop={10}
        style={styles.backBtn}
      >
        <Text style={styles.backArrow}>‹</Text>
      </TouchableOpacity>
      <View style={styles.headerTitleCol}>
        <Text style={styles.headerTitle}>Standing indent</Text>
        <Text style={styles.headerSubtitle}>Set your daily defaults</Text>
      </View>
    </View>
  );
}

// ── Product row ─────────────────────────────────────────────────────
function ProductRow({
  product,
  edit,
  dirty,
  onActiveToggle,
  onIncrement,
  onDecrement,
}: {
  product: EligibleProduct;
  edit: LocalEdit;
  dirty: boolean;
  onActiveToggle: (v: boolean) => void;
  onIncrement: () => void;
  onDecrement: () => void;
}) {
  const inactive = !edit.active;
  return (
    <View style={[styles.row, dirty && styles.rowDirty]}>
      <View style={styles.thumb}>
        {product.imageUrl ? (
          <Image
            source={{ uri: product.imageUrl }}
            style={styles.thumbImg}
            resizeMode="contain"
          />
        ) : (
          <Text style={styles.thumbEmoji}>{product.icon ?? "📦"}</Text>
        )}
      </View>

      <View style={styles.rowBody}>
        <Text style={[styles.rowName, inactive && styles.rowNameInactive]} numberOfLines={1}>
          {product.productName}
        </Text>
        <Text style={styles.rowMeta}>
          ₹{product.basePrice.toFixed(2)} · {product.unit}
        </Text>
      </View>

      <View style={styles.rowControls}>
        <View style={[styles.stepper, inactive && styles.stepperInactive]}>
          <TouchableOpacity
            onPress={onDecrement}
            disabled={inactive}
            activeOpacity={0.7}
            style={styles.stepBtn}
          >
            <Text style={styles.stepIcon}>−</Text>
          </TouchableOpacity>
          <Text style={styles.stepVal}>{edit.defaultQty}</Text>
          <TouchableOpacity
            onPress={onIncrement}
            disabled={inactive}
            activeOpacity={0.7}
            style={styles.stepBtn}
          >
            <Text style={styles.stepIcon}>+</Text>
          </TouchableOpacity>
        </View>
        <Switch
          value={edit.active}
          onValueChange={onActiveToggle}
          trackColor={{ false: colors.border, true: colors.primary }}
          thumbColor={colors.card}
          style={styles.switch}
        />
      </View>
    </View>
  );
}

// ════════════════════════════════════════════════════════════════════
// Styles
// ════════════════════════════════════════════════════════════════════

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },

  // Header
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingBottom: 10,
    backgroundColor: colors.card,
    borderBottomWidth: 0.5,
    borderBottomColor: colors.border,
  },
  backBtn: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  backArrow: {
    fontSize: 26,
    fontFamily: fonts.medium,
    color: colors.primary,
    lineHeight: 28,
  },
  headerTitleCol: {
    flex: 1,
    marginLeft: 4,
  },
  headerTitle: {
    fontSize: 14,
    fontFamily: fonts.bold,
    color: colors.foreground,
  },
  headerSubtitle: {
    fontSize: 11,
    fontFamily: fonts.medium,
    color: colors.mutedForeground,
    marginTop: 1,
  },

  // Sub-header
  subHeader: {
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 4,
  },
  subHeaderText: {
    fontSize: 12,
    fontFamily: fonts.medium,
    color: colors.mutedForeground,
    lineHeight: 17,
  },

  // Search
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

  // List
  list: { flex: 1 },
  listContent: { paddingTop: 10, paddingHorizontal: 12 },

  row: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.card,
    borderRadius: 6,
    borderWidth: 0.5,
    borderColor: colors.border,
    padding: 10,
    marginBottom: 8,
    gap: 10,
  },
  rowDirty: {
    borderColor: colors.primary,
    backgroundColor: colors.primaryLight,
  },
  thumb: {
    width: 40,
    height: 40,
    borderRadius: 4,
    backgroundColor: colors.background,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  thumbImg: { width: "85%", height: "85%" },
  thumbEmoji: { fontSize: 22 },
  rowBody: { flex: 1 },
  rowName: {
    fontSize: 12,
    fontFamily: fonts.semibold,
    color: colors.foreground,
  },
  rowNameInactive: { color: colors.mutedForeground },
  rowMeta: {
    fontSize: 11,
    fontFamily: fonts.medium,
    color: colors.mutedForeground,
    marginTop: 1,
  },
  rowControls: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  stepper: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.background,
    borderWidth: 0.5,
    borderColor: colors.border,
    borderRadius: 4,
    overflow: "hidden",
  },
  stepperInactive: { opacity: 0.4 },
  stepBtn: {
    width: 24,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  stepIcon: {
    fontSize: 14,
    fontFamily: fonts.bold,
    color: colors.foreground,
  },
  stepVal: {
    minWidth: 22,
    textAlign: "center",
    fontSize: 12,
    fontFamily: fonts.extrabold,
    color: colors.foreground,
  },
  switch: { transform: [{ scaleX: 0.85 }, { scaleY: 0.85 }] },

  // Empty
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
  emptySub: {
    fontSize: 11,
    fontFamily: fonts.medium,
    color: colors.mutedForeground,
    marginTop: 6,
    textAlign: "center",
    lineHeight: 17,
  },
  loading: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },

  // Sticky save bar
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
    paddingVertical: 10,
    paddingHorizontal: 14,
    gap: 12,
  },
  stickyInfo: { flex: 1, flexDirection: "row", alignItems: "baseline", gap: 6 },
  stickyCount: {
    fontSize: 16,
    fontFamily: fonts.extrabold,
    color: colors.yellowAccent,
  },
  stickyLabel: {
    fontSize: 11,
    fontFamily: fonts.medium,
    color: "rgba(255,255,255,0.75)",
  },
  saveBtn: {
    paddingVertical: 9,
    paddingHorizontal: 16,
    borderRadius: 4,
    backgroundColor: colors.primary,
  },
  saveBtnDisabled: { opacity: 0.6 },
  saveBtnText: {
    fontSize: 12,
    fontFamily: fonts.extrabold,
    color: colors.primaryForeground,
  },
});