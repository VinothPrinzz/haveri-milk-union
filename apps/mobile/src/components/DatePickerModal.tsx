import React, { useMemo, useState } from "react";
import {
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
} from "react-native";
import { colors, fonts } from "../lib/theme";
import { istTodayIso } from "../store/targetDate";

/**
 * DatePickerModal — a compact month-grid calendar.
 *
 * No external dependency — pure RN. Lets the dealer pick any date
 * from today up to `maxDaysAhead` in the future. Past dates and
 * dates beyond the range are disabled.
 *
 *   <DatePickerModal
 *     visible={show}
 *     selectedDate={selectedDate}
 *     onSelect={(iso) => { setSelectedDate(iso); setShow(false); }}
 *     onClose={() => setShow(false)}
 *   />
 */

interface DatePickerModalProps {
  visible: boolean;
  selectedDate: string; // YYYY-MM-DD
  onSelect: (isoDate: string) => void;
  onClose: () => void;
  /** How many days ahead the dealer may schedule. Default 30. */
  maxDaysAhead?: number;
}

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function isoOf(year: number, month: number, day: number): string {
  const mm = String(month + 1).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

export default function DatePickerModal({
  visible,
  selectedDate,
  onSelect,
  onClose,
  maxDaysAhead = 30,
}: DatePickerModalProps) {
  const todayIso = istTodayIso();

  // The month currently shown — starts on the selected date's month.
  const initial = useMemo(() => {
    const d = new Date((selectedDate || todayIso) + "T00:00:00Z");
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() };
  }, [selectedDate, todayIso, visible]);

  const [view, setView] = useState(initial);

  // Reset the viewed month whenever the modal re-opens
  React.useEffect(() => {
    if (visible) setView(initial);
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  // Compute the max selectable date
  const maxIso = useMemo(() => {
    const d = new Date(todayIso + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + maxDaysAhead);
    return d.toISOString().slice(0, 10);
  }, [todayIso, maxDaysAhead]);

  // Build the grid for the viewed month
  const grid = useMemo(() => {
    const firstDay = new Date(Date.UTC(view.year, view.month, 1));
    const startWeekday = firstDay.getUTCDay(); // 0=Sun
    const daysInMonth = new Date(
      Date.UTC(view.year, view.month + 1, 0)
    ).getUTCDate();

    const cells: (number | null)[] = [];
    for (let i = 0; i < startWeekday; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) cells.push(d);
    while (cells.length % 7 !== 0) cells.push(null);
    return cells;
  }, [view]);

  const canGoPrev = useMemo(() => {
    // Don't allow navigating before the current month
    const t = new Date(todayIso + "T00:00:00Z");
    return (
      view.year > t.getUTCFullYear() ||
      (view.year === t.getUTCFullYear() && view.month > t.getUTCMonth())
    );
  }, [view, todayIso]);

  const canGoNext = useMemo(() => {
    const m = new Date(maxIso + "T00:00:00Z");
    return (
      view.year < m.getUTCFullYear() ||
      (view.year === m.getUTCFullYear() && view.month < m.getUTCMonth())
    );
  }, [view, maxIso]);

  const goPrev = () => {
    if (!canGoPrev) return;
    setView((v) =>
      v.month === 0
        ? { year: v.year - 1, month: 11 }
        : { year: v.year, month: v.month - 1 }
    );
  };
  const goNext = () => {
    if (!canGoNext) return;
    setView((v) =>
      v.month === 11
        ? { year: v.year + 1, month: 0 }
        : { year: v.year, month: v.month + 1 }
    );
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={styles.backdrop} />
      </TouchableWithoutFeedback>

      <View style={styles.center} pointerEvents="box-none">
        <View style={styles.card}>
          {/* Month nav */}
          <View style={styles.navRow}>
            <TouchableOpacity
              onPress={goPrev}
              disabled={!canGoPrev}
              hitSlop={8}
              style={styles.navBtn}
            >
              <Text
                style={[styles.navArrow, !canGoPrev && styles.navArrowDisabled]}
              >
                ‹
              </Text>
            </TouchableOpacity>
            <Text style={styles.monthLabel}>
              {MONTHS[view.month]} {view.year}
            </Text>
            <TouchableOpacity
              onPress={goNext}
              disabled={!canGoNext}
              hitSlop={8}
              style={styles.navBtn}
            >
              <Text
                style={[styles.navArrow, !canGoNext && styles.navArrowDisabled]}
              >
                ›
              </Text>
            </TouchableOpacity>
          </View>

          {/* Weekday header */}
          <View style={styles.weekRow}>
            {WEEKDAYS.map((w, i) => (
              <View key={i} style={styles.weekCell}>
                <Text style={styles.weekText}>{w}</Text>
              </View>
            ))}
          </View>

          {/* Day grid */}
          <View style={styles.grid}>
            {grid.map((day, idx) => {
              if (day === null) {
                return <View key={idx} style={styles.dayCell} />;
              }
              const iso = isoOf(view.year, view.month, day);
              const isPast = iso < todayIso;
              const isBeyond = iso > maxIso;
              const disabled = isPast || isBeyond;
              const isSelected = iso === selectedDate;
              const isToday = iso === todayIso;

              return (
                <TouchableOpacity
                  key={idx}
                  style={styles.dayCell}
                  disabled={disabled}
                  activeOpacity={0.6}
                  onPress={() => onSelect(iso)}
                >
                  <View
                    style={[
                      styles.dayInner,
                      isSelected && styles.daySelected,
                      isToday && !isSelected && styles.dayToday,
                    ]}
                  >
                    <Text
                      style={[
                        styles.dayText,
                        disabled && styles.dayTextDisabled,
                        isSelected && styles.dayTextSelected,
                      ]}
                    >
                      {day}
                    </Text>
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>

          <TouchableOpacity
            onPress={onClose}
            activeOpacity={0.7}
            style={styles.closeBtn}
          >
            <Text style={styles.closeBtnText}>Close</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.45)",
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 28,
  },
  card: {
    width: "100%",
    maxWidth: 340,
    backgroundColor: colors.card,
    borderRadius: 10,
    padding: 16,
  },
  navRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 12,
  },
  navBtn: {
    width: 34,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
  },
  navArrow: {
    fontSize: 26,
    fontFamily: fonts.medium,
    color: colors.primary,
    lineHeight: 28,
  },
  navArrowDisabled: { color: colors.border },
  monthLabel: {
    fontSize: 14,
    fontFamily: fonts.bold,
    color: colors.foreground,
  },
  weekRow: {
    flexDirection: "row",
    marginBottom: 4,
  },
  weekCell: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 4,
  },
  weekText: {
    fontSize: 11,
    fontFamily: fonts.bold,
    color: colors.mutedForeground,
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
  },
  dayCell: {
    width: `${100 / 7}%`,
    aspectRatio: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  dayInner: {
    width: 34,
    height: 34,
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center",
  },
  daySelected: {
    backgroundColor: colors.primary,
  },
  dayToday: {
    borderWidth: 1,
    borderColor: colors.primary,
  },
  dayText: {
    fontSize: 13,
    fontFamily: fonts.semibold,
    color: colors.foreground,
  },
  dayTextDisabled: {
    color: colors.border,
  },
  dayTextSelected: {
    color: colors.primaryForeground,
    fontFamily: fonts.extrabold,
  },
  closeBtn: {
    marginTop: 12,
    paddingVertical: 10,
    alignItems: "center",
    borderRadius: 6,
    backgroundColor: colors.background,
  },
  closeBtnText: {
    fontSize: 12,
    fontFamily: fonts.bold,
    color: colors.foreground,
  },
});