import React, { useMemo, useState, useRef } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  Modal,
} from "react-native";
import DateTimePicker from "@react-native-community/datetimepicker";
import { LinearGradient } from "expo-linear-gradient";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQueryClient } from "@tanstack/react-query";
import {
  colors,
  cssAngleToPoints,
  fonts,
  shadows,
} from "../lib/theme";
import { useAuthStore } from "../store/auth";
import { useMyInvoices, useBulkInvoiceDownload } from "../hooks/useInvoices";
import { qk } from "../lib/queryKeys";
import type { Invoice } from "../lib/types";

interface MonthOption {
  id: string; // YYYY-MM
  label: string; // "Jan 2025"
}

export default function InvoicesScreen() {
  const insets = useSafeAreaInsets();
  const dealer = useAuthStore((s) => s.dealer);
  const invQuery = useMyInvoices();
  const bulk = useBulkInvoiceDownload();
  const qc = useQueryClient();

  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Custom range state
  const [customRange, setCustomRange] = useState<{ from: Date; to: Date } | null>(null);
  const [pickerOpen, setPickerOpen] = useState<null | "from" | "to">(null);
  const [draftFrom, setDraftFrom] = useState<Date>(new Date());
  const [draftTo, setDraftTo] = useState<Date>(new Date());

  const pickedFromRef = useRef<Date | null>(null); // ← NEW

  // ── Derived: month options from invoices ───────────────────────────
  const monthOptions: MonthOption[] = useMemo(() => {
    const invoices = invQuery.data?.invoices ?? [];
    const seen = new Map<string, MonthOption>();

    // Always include the server's "current month" first
    const serverCurMonth = invQuery.data?.summary.currentMonthId;
    if (serverCurMonth) {
      seen.set(serverCurMonth, {
        id: serverCurMonth,
        label: formatMonthFromId(serverCurMonth),
      });
    } else {
      // Pre-API-deploy fallback: use device's current month
      const now = new Date();
      const curId = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      seen.set(curId, { id: curId, label: formatMonth(now) });
    }

    // Add any other months represented in the invoice list
    for (const inv of invoices) {
      if (!inv.monthId) continue;
      if (!seen.has(inv.monthId)) {
        seen.set(inv.monthId, {
          id: inv.monthId,
          label: formatMonthFromId(inv.monthId),
        });
      }
    }
    return Array.from(seen.values()).sort((a, b) => b.id.localeCompare(a.id));
  }, [invQuery.data]);

  const effectiveMonth = selectedMonth ?? monthOptions[0]?.id ?? "";

  // ── Derived: filtered invoices (server-tagged, no client date math) ──
  const filteredInvoices = useMemo(() => {
    const invoices = invQuery.data?.invoices ?? [];
    if (customRange) {
      const fromMs = new Date(customRange.from).setHours(0, 0, 0, 0);
      const toMs   = new Date(customRange.to).setHours(23, 59, 59, 999);
      return invoices.filter((inv) => {
        const t = new Date(inv.invoiceDate).getTime();
        return t >= fromMs && t <= toMs;
      });
    }
    if (!effectiveMonth) return invoices;
    return invoices.filter((inv) => inv.monthId === effectiveMonth);
    // ↑ pure string equality on a server-computed tag — no Date(), no timezone
  }, [invQuery.data, effectiveMonth, customRange]);

  // ── Derived: month-specific summary ─────────────────────────
  const monthSummary = useMemo(() => {
    if (!selectedMonth && !customRange) {
      return invQuery.data?.summary ?? { totalOrders: 0, totalGst: 0, invoiceCount: 0 };
    }
    const totalOrders = filteredInvoices.reduce((a, i) => a + i.totalAmount, 0);
    const totalGst = filteredInvoices.reduce((a, i) => a + i.totalTax, 0);
    return { totalOrders, totalGst, invoiceCount: filteredInvoices.length };
  }, [selectedMonth, customRange, filteredInvoices, invQuery.data]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try { await invQuery.refetch(); } finally { setRefreshing(false); }
  };

  const handleDownloadPdf = async (inv: Invoice) => {
    if (!inv.pdfUrl) {
      Alert.alert(
        "PDF Not Ready",
        "This invoice's PDF is being generated. Please check back in a few minutes."
      );
      return;
    }
    try {
      const supported = await Linking.canOpenURL(inv.pdfUrl);
      if (supported) await Linking.openURL(inv.pdfUrl);
      else Alert.alert("Cannot open", "Could not open the invoice PDF.");
    } catch {
      Alert.alert("Cannot open", "Could not open the invoice PDF.");
    }
  };

  // ── Updated Bulk Download Handler ─────────────────────────────
  const handleDownloadAll = async () => {
    const allInvoices = invQuery.data?.invoices ?? [];
    // If nothing in the filter, but we DO have invoices, download all of
    // them. Otherwise download what the filter shows.
    const inScope = filteredInvoices.length > 0
      ? filteredInvoices
      : allInvoices;
  
    if (inScope.length === 0) {
      Alert.alert(
        "No Invoices",
        "You don't have any invoices yet. Place an order to generate one."
      );
      return;
    }
    if (inScope.length > 50) {
      Alert.alert("Too Many", "Filter to 50 or fewer invoices first.");
      return;
    }
  
    let url: string;
    try {
      url = await bulk.mutateAsync(inScope.map((i) => i.orderId));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not prepare bundle.";
      Alert.alert("Download Failed", msg);
      return;
    }
  
    qc.invalidateQueries({ queryKey: qk.invoices.all });
  
    try {
      await Linking.openURL(url);
    } catch {
      Alert.alert("Cannot open", "Could not open the bundled invoice file.");
    }
  };

  // ── Render ─────────────────────────────────────────────────────────
  if (invQuery.isLoading && !invQuery.data) {
    return (
      <View style={styles.firstLoad}>
        <ActivityIndicator color={colors.primary} size="large" />
        <Text style={styles.firstLoadText}>Loading invoices…</Text>
      </View>
    );
  }

  const { start, end } = cssAngleToPoints(135);

  return (
    <View style={styles.root}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: Math.max(insets.top + 8, 42) }]}>
        <Text style={styles.headerTitle}>GST Invoices</Text>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterScroll}
        >
          {monthOptions.map((m) => {
            const active = m.id === effectiveMonth && !customRange;
            return (
              <TouchableOpacity
                key={m.id}
                activeOpacity={0.75}
                onPress={() => {
                  setSelectedMonth(m.id);
                  setCustomRange(null);
                }}
                style={[styles.fTab, active && styles.fTabActive]}
              >
                <Text style={[styles.fTabText, active && styles.fTabTextActive]}>
                  {m.label}
                </Text>
              </TouchableOpacity>
            );
          })}
          {/* Custom range pill */}
          <TouchableOpacity
            activeOpacity={0.75}
            onPress={() => {
              const now = new Date();
              const start = new Date(now.getFullYear(), now.getMonth(), 1);
              setDraftFrom(start);
              setDraftTo(now);
              pickedFromRef.current = null; // reset
              setPickerOpen("from");
            }}
            style={[styles.fTab, customRange && styles.fTabActive]}
          >
            <Text style={styles.gscLabel}>
              {customRange
                ? `${formatShort(customRange.from)} – ${formatShort(customRange.to)} · GST Summary`
                : `${formatMonthFromId(effectiveMonth).toUpperCase()} · GST SUMMARY`}
            </Text>
          </TouchableOpacity>
        </ScrollView>
      </View>

      <ScrollView
        style={styles.body}
        contentContainerStyle={styles.bodyContent}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={colors.primary}
          />
        }
      >
        {/* GST Summary card */}
        <LinearGradient
          colors={["#1448CC", "#0D2B8F"] as unknown as [string, string]}
          start={start}
          end={end}
          style={styles.summaryCard}
        >
          <Text style={styles.gscLabel}>
            {customRange
              ? `${formatShort(customRange.from)} – ${formatShort(customRange.to)} · GST Summary`
              : `${labelForMonthId(effectiveMonth)} · GST Summary`}
          </Text>
          <View style={styles.gscRow}>
            <SummaryItem
              value={formatRupees(monthSummary.totalOrders)}
              label="Total Orders"
            />
            <SummaryItem
              value={formatRupees(monthSummary.totalGst)}
              label="Total GST Paid"
            />
            <SummaryItem
              value={String(monthSummary.invoiceCount)}
              label={monthSummary.invoiceCount === 1 ? "Invoice" : "Invoices"}
            />
          </View>
          <TouchableOpacity
            activeOpacity={0.85}
            onPress={handleDownloadAll}
            style={styles.gscDownload}
            disabled={(invQuery.data?.invoices ?? []).length === 0}
            // ↑ button enabled if dealer has ANY invoice, even if filter shows nothing
          >
            <Text style={styles.gscDownloadText}>
              📥 Download All Invoices (PDF)
            </Text>
          </TouchableOpacity>
        </LinearGradient>

        {/* Empty state */}
        {filteredInvoices.length === 0 && (
          <View style={styles.empty}>
            <Text style={styles.emptyEmoji}>🧾</Text>
            {(invQuery.data?.invoices ?? []).length === 0 ? (
              <>
                <Text style={styles.emptyTitle}>No invoices yet</Text>
                <Text style={styles.emptySub}>
                  Invoices appear after your orders are placed.
                </Text>
              </>
            ) : (
              <>
                <Text style={styles.emptyTitle}>Nothing for this period</Text>
                <Text style={styles.emptySub}>
                  {customRange
                    ? "No invoices in the selected date range."
                    : "No invoices in this month — try another."}
                </Text>
              </>
            )}
          </View>
        )}

        {/* Invoice list */}
        {filteredInvoices.length > 0 && (
          <>
            <Text style={styles.monthLabel}>
              {customRange
                ? `${formatShort(customRange.from)} – ${formatShort(customRange.to)}`
                : labelForMonthId(effectiveMonth)}
            </Text>
            {filteredInvoices.map((inv) => (
              <InvoiceCard
                key={inv.id}
                invoice={inv}
                location={dealer?.locationLabel ?? dealer?.zoneName ?? "Haveri"}
                onDownload={() => handleDownloadPdf(inv)}
              />
            ))}
          </>
        )}
      </ScrollView>

      {/* Date Pickers */}
      {pickerOpen === "from" && (
        <DateTimePicker
          value={draftFrom}
          mode="date"
          maximumDate={new Date()}
          onChange={(event, d) => {
            setPickerOpen(null);
            if (event.type === "set" && d) {
              const fromDate = new Date(d); // copy
              fromDate.setHours(0, 0, 0, 0);
              pickedFromRef.current = fromDate; // ← stash it
              setDraftFrom(fromDate);
              setPickerOpen("to");
            }
          }}
        />
      )}
      {pickerOpen === "to" && (
        <DateTimePicker
          value={draftTo}
          mode="date"
          minimumDate={pickedFromRef.current ?? draftFrom}
          maximumDate={new Date()}
          onChange={(event, d) => {
            setPickerOpen(null);
            if (event.type === "set" && d) {
              const toDate = new Date(d);
              toDate.setHours(23, 59, 59, 999);
              const fromDate = pickedFromRef.current ?? draftFrom;
              setDraftTo(toDate);
              setCustomRange({ from: fromDate, to: toDate }); // ← uses ref, not stale state
              setSelectedMonth(null);
            }
          }}
        />
      )}
    </View>
  );
}

// ════════════════════════════════════════════════════════════════════════
// SummaryItem, InvoiceCard, Helpers & Styles remain UNCHANGED
// ════════════════════════════════════════════════════════════════════════

function SummaryItem({ value, label }: { value: string; label: string }) {
  return (
    <View style={summaryStyles.item}>
      <Text style={summaryStyles.value} numberOfLines={1}>{value}</Text>
      <Text style={summaryStyles.label}>{label}</Text>
    </View>
  );
}

interface InvoiceCardProps {
  invoice: Invoice;
  location: string;
  onDownload: () => void;
}

function InvoiceCard({ invoice, location, onDownload }: InvoiceCardProps) {
  return (
    <View style={cardStyles.card}>
      <View style={cardStyles.iconWrap}>
        <Text style={cardStyles.iconText}>🧾</Text>
      </View>
      <View style={cardStyles.info}>
        <Text style={cardStyles.num} numberOfLines={1}>
          {invoice.invoiceNumber}
        </Text>
        <Text style={cardStyles.meta} numberOfLines={1}>
          {formatShortDate(invoice.invoiceDate)} · {invoice.itemCount} items · {location}
        </Text>
        <View style={cardStyles.gstBadge}>
          <Text style={cardStyles.gstText}>GST: ₹{invoice.totalTax.toFixed(2)}</Text>
        </View>
      </View>
      <View style={cardStyles.right}>
        <Text style={cardStyles.amount}>₹{Math.round(invoice.totalAmount)}</Text>
        <TouchableOpacity
          onPress={onDownload}
          activeOpacity={0.75}
          style={cardStyles.dlBtn}
        >
          <Text style={cardStyles.dlText}>📥 PDF</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function formatMonth(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

function labelForMonthId(id: string): string {
  if (!id) return "";
  const [y, m] = id.split("-").map((n) => parseInt(n, 10));
  if (Number.isNaN(y) || Number.isNaN(m)) return id;
  return new Date(y, m - 1, 1).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
}

function formatShortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { day: "numeric", month: "short" });
}

function formatShort(d: Date): string {
  return d.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short"
  });
}

function formatRupees(amount: number): string {
  const rounded = Math.round(amount);
  const s = String(rounded);
  if (s.length <= 3) return `₹${s}`;
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3);
  const restWithCommas = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `₹${restWithCommas},${last3}`;
}

function formatMonthFromId(id: string): string {
  if (!id) return "";
  const [yearStr, monthStr] = id.split("-");
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10) - 1;
  if (isNaN(year) || isNaN(month)) return id;
  const d = new Date(year, month, 1);
  return d.toLocaleDateString("en-IN", { month: "short", year: "numeric" });
}

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
  // Header
  header: {
    backgroundColor: colors.card,
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerTitle: {
    fontFamily: fonts.headingExtra,
    fontSize: 15,
    color: colors.foreground,
  },
  filterScroll: {
    gap: 6,
    marginTop: 10,
    paddingRight: 16,
  },
  fTab: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.background,
  },
  fTabActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  fTabText: {
    fontSize: 10,
    fontFamily: fonts.bold,
    color: colors.mutedForeground,
  },
  fTabTextActive: {
    color: colors.primaryForeground,
  },
  // Body
  body: {
    flex: 1,
  },
  bodyContent: {
    paddingBottom: 24,
  },
  // Summary card
  summaryCard: {
    borderRadius: 14,
    paddingVertical: 13,
    paddingHorizontal: 14,
    marginTop: 12,
    marginHorizontal: 12,
  },
  gscLabel: {
    fontSize: 8,
    fontFamily: fonts.bold,
    color: "rgba(255,255,255,0.6)",
    textTransform: "uppercase",
    letterSpacing: 1,
    marginBottom: 9,
  },
  gscRow: {
    flexDirection: "row",
    gap: 14,
  },
  gscDownload: {
    marginTop: 10,
    backgroundColor: "rgba(255,255,255,0.12)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.2)",
    borderRadius: 7,
    paddingVertical: 7,
    paddingHorizontal: 11,
    alignItems: "center",
  },
  gscDownloadText: {
    fontSize: 10,
    fontFamily: fonts.bold,
    color: colors.primaryForeground,
  },
  // Empty
  empty: {
    alignItems: "center",
    paddingVertical: 56,
    paddingHorizontal: 24,
  },
  emptyEmoji: {
    fontSize: 48,
    marginBottom: 12,
  },
  emptyTitle: {
    fontSize: 15,
    fontFamily: fonts.extrabold,
    color: colors.foreground,
  },
  emptySub: {
    fontSize: 11,
    fontFamily: fonts.medium,
    color: colors.mutedForeground,
    marginTop: 6,
    textAlign: "center",
  },
  // Month label
  monthLabel: {
    fontSize: 10,
    fontFamily: fonts.extrabold,
    color: colors.mutedForeground,
    textTransform: "uppercase",
    letterSpacing: 0.8,
    marginTop: 15,
    marginBottom: 7,
    marginHorizontal: 12,
  },
});

const summaryStyles = StyleSheet.create({
  item: {
    flex: 1,
  },
  value: {
    fontFamily: fonts.headingBlack,
    fontSize: 13,
    color: colors.primaryForeground,
  },
  label: {
    fontSize: 9,
    fontFamily: fonts.semibold,
    color: "rgba(255,255,255,0.6)",
    marginTop: 2,
  },
});

const cardStyles = StyleSheet.create({
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    backgroundColor: colors.card,
    borderRadius: 11,
    paddingVertical: 11,
    paddingHorizontal: 12,
    marginBottom: 7,
    marginHorizontal: 12,
    ...shadows.sm,
  },
  iconWrap: {
    width: 38,
    height: 38,
    borderRadius: 11,
    backgroundColor: colors.primaryLight,
    alignItems: "center",
    justifyContent: "center",
  },
  iconText: {
    fontSize: 17,
  },
  info: {
    flex: 1,
  },
  num: {
    fontSize: 11,
    fontFamily: fonts.extrabold,
    color: colors.foreground,
  },
  meta: {
    fontSize: 9,
    fontFamily: fonts.medium,
    color: colors.mutedForeground,
    marginTop: 2,
  },
  gstBadge: {
    alignSelf: "flex-start",
    backgroundColor: colors.infoLight,
    paddingVertical: 2,
    paddingHorizontal: 6,
    borderRadius: 3,
    marginTop: 3,
  },
  gstText: {
    fontSize: 8,
    fontFamily: fonts.bold,
    color: colors.info,
  },
  right: {
    alignItems: "flex-end",
    gap: 5,
  },
  amount: {
    fontSize: 12,
    fontFamily: fonts.headingBlack,
    color: colors.foreground,
  },
  dlBtn: {
    backgroundColor: colors.primaryLight,
    paddingVertical: 4,
    paddingHorizontal: 9,
    borderRadius: 7,
  },
  dlText: {
    fontSize: 9,
    fontFamily: fonts.bold,
    color: colors.primary,
  },
});