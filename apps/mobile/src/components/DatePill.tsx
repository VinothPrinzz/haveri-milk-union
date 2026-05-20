import React, { useMemo } from "react";
import {
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { colors, fonts } from "../lib/theme";
import {
  istTodayIso,
  istTomorrowIso,
  relativeLabel,
  useTargetDateStore,
} from "../store/targetDate";
import type { WindowStatus } from "../lib/types";

/**
 * DatePill — the persistent "Adding to: {date} · {context}" pill that
 * sits at the top of the Home and Categories tabs.
 *
 * It's the dealer's anchor — without it, tapping `+` on a product
 * card is ambiguous (which day are they ordering for?). The pill
 * tells them, and tapping it opens the Indent tab where they can
 * switch dates.
 *
 * Visual states:
 *   • TODAY + window open      → blue tint, "closes in Xh Ym"
 *   • TODAY + warning          → amber tint, "closes in Xm"
 *   • TODAY + closed           → red tint, "window closed — switch?"
 *                                 (rare — DatePill auto-advances via
 *                                 the store when window closes)
 *   • TOMORROW or later        → neutral tint, "editable anytime"
 */

interface DatePillProps {
  windowStatus?: WindowStatus | null;
  /** Caller's handler — typically switches tab to "indent" */
  onPress: () => void;
}

function formatRemaining(seconds: number): string {
  const totalMin = Math.max(0, Math.ceil(seconds / 60));
  if (totalMin <= 0) return "closing";
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return `${h}h ${m}m left`;
  return `${m}m left`;
}

export default function DatePill({ windowStatus, onPress }: DatePillProps) {
  const selectedDate = useTargetDateStore((s) => s.selectedDate);

  const { variant, contextText } = useMemo(() => {
    const today = istTodayIso();
    const tomorrow = istTomorrowIso();

    if (selectedDate === today) {
      const state = windowStatus?.state ?? "closed";
      if (state === "open") {
        return {
          variant: "open" as const,
          contextText: formatRemaining(windowStatus?.remainingSeconds ?? 0),
        };
      }
      if (state === "warning") {
        return {
          variant: "warning" as const,
          contextText: formatRemaining(windowStatus?.remainingSeconds ?? 0),
        };
      }
      return {
        variant: "closed" as const,
        contextText: "window closed",
      };
    }

    if (selectedDate === tomorrow) {
      return {
        variant: "future" as const,
        contextText: "editable anytime",
      };
    }

    return {
      variant: "future" as const,
      contextText: "scheduled order",
    };
  }, [selectedDate, windowStatus]);

  const dateLabel = relativeLabel(selectedDate);

  return (
    <TouchableOpacity
      activeOpacity={0.7}
      onPress={onPress}
      style={[styles.root, VARIANT_STYLES[variant].wrap]}
      accessibilityRole="button"
      accessibilityLabel={`Adding to ${dateLabel}. Tap to change date.`}
    >
      <Text style={[styles.icon, VARIANT_STYLES[variant].icon]}>📅</Text>
      <View style={styles.body}>
        <Text style={[styles.label, VARIANT_STYLES[variant].label]}>
          Adding to:{" "}
          <Text style={[styles.value, VARIANT_STYLES[variant].value]}>
            {dateLabel}
          </Text>
        </Text>
        <Text style={[styles.context, VARIANT_STYLES[variant].context]}>
          {contextText}
        </Text>
      </View>
      <Text style={[styles.chevron, VARIANT_STYLES[variant].chevron]}>›</Text>
    </TouchableOpacity>
  );
}

// ── Styles ─────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: {
    marginHorizontal: 12,
    marginTop: 10,
    paddingVertical: 8,
    paddingHorizontal: 11,
    borderRadius: 6,
    borderWidth: 0.5,
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
  },
  icon: {
    fontSize: 15,
  },
  body: {
    flex: 1,
  },
  label: {
    fontSize: 11,
    fontFamily: fonts.medium,
  },
  value: {
    fontFamily: fonts.bold,
  },
  context: {
    fontSize: 10,
    fontFamily: fonts.medium,
    marginTop: 1,
  },
  chevron: {
    fontSize: 18,
    fontFamily: fonts.medium,
  },
});

// ── Variant theming ────────────────────────────────────────────────
// Each variant overrides bg/border + the colors of icon, label, value,
// context, chevron. Kept as a lookup table so adding a new state is
// just adding a key.

const VARIANT_STYLES: Record<
  "open" | "warning" | "closed" | "future",
  {
    wrap: object;
    icon: object;
    label: object;
    value: object;
    context: object;
    chevron: object;
  }
> = {
  open: {
    wrap: { backgroundColor: colors.primaryLight, borderColor: colors.primaryLight2 },
    icon: { color: colors.primary },
    label: { color: colors.mutedForeground },
    value: { color: colors.primary },
    context: { color: "#92400E" },
    chevron: { color: colors.mutedForeground },
  },
  warning: {
    wrap: { backgroundColor: "#FAEEDA", borderColor: "#FAC775" },
    icon: { color: "#92400E" },
    label: { color: "#633806" },
    value: { color: "#854F0B" },
    context: { color: "#92400E" },
    chevron: { color: "#854F0B" },
  },
  closed: {
    wrap: { backgroundColor: "#FEE2E2", borderColor: "#F7C1C1" },
    icon: { color: "#A32D2D" },
    label: { color: "#791F1F" },
    value: { color: "#A32D2D" },
    context: { color: "#A32D2D" },
    chevron: { color: "#791F1F" },
  },
  future: {
    wrap: { backgroundColor: colors.background, borderColor: colors.border },
    icon: { color: colors.foreground },
    label: { color: colors.mutedForeground },
    value: { color: colors.foreground },
    context: { color: colors.mutedForeground },
    chevron: { color: colors.mutedForeground },
  },
};