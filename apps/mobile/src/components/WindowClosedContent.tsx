import React, { useEffect, useState } from "react";
import {
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { colors, fonts, shadows } from "../lib/theme";
import type { Order } from "../lib/types";

/**
 * WindowClosedContent — replaces the normal scrollable body when
 * windowState === "closed" (spec §6.9, mockup lines 693-716).
 *
 * Three blocks:
 *   1. Countdown card (.countdown-card)
 *        moon emoji 40px, title 13px Unbounded extrabold, sub 10px,
 *        H/M/S tiles 48px wide, value 18px Unbounded black brand color, label 7px,
 *        bottom "Window: 6:00 AM - 8:00 AM daily" pill on brand-light bg
 *
 *   2. Today's Activity card (.today-summary)
 *        "Today's Activity" header + "View all" link, then list of order rows.
 *
 *   3. Notification opt-in card (inline style in mockup, lines 711-715)
 *        bell emoji + 2-line text + iOS-style toggle.
 *
 * Countdown logic:
 *   The parent passes `nextOpenAt` (a Date object pointing at tomorrow's open time).
 *   We tick every second locally so the H/M/S display stays smooth without hammering
 *   the API. The window status query still polls every 30s to flip back to "open"
 *   when the time arrives.
 */

interface WindowClosedContentProps {
  /** When the next ordering window opens (Date object). */
  nextOpenAt: Date;
  /** Window times for the bottom info pill, e.g. openTime="6:00 AM". */
  openTime: string;
  closeTime: string;
  /** Today's orders for the "Today's Activity" section. Pass [] if empty. */
  todaysOrders: Order[];
  /** Current value of the notification toggle. */
  notificationsEnabled: boolean;
  /** Called when the user flips the toggle. */
  onNotificationsChange: (enabled: boolean) => void;
  /** "View all" button on Today's Activity. */
  onViewAllOrders?: () => void;
}

// Helpers --------------------------------------------------------------

function diffParts(target: Date, now: Date) {
  const totalMs = Math.max(0, target.getTime() - now.getTime());
  const totalSec = Math.floor(totalMs / 1000);
  const hours = Math.floor(totalSec / 3600);
  const mins  = Math.floor((totalSec % 3600) / 60);
  const secs  = totalSec % 60;
  return { hours, mins, secs };
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formatOrderTime(iso: string): string {
  try {
    const d = new Date(iso);
    
    // ← Added safe guard (same pattern as formatRelativeDate)
    if (isNaN(d.getTime())) return "—";

    let h = d.getHours();
    const m = d.getMinutes();
    const ampm = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
    return `${h}:${pad2(m)} ${ampm}`;
  } catch {
    return "—";   // Also improved fallback for consistency
  }
}

function isPaid(status: Order["status"]): boolean {
  return status === "confirmed" || status === "dispatched" || status === "delivered";
}

// Main -----------------------------------------------------------------

export default function WindowClosedContent({
  nextOpenAt,
  openTime,
  closeTime,
  todaysOrders,
  notificationsEnabled,
  onNotificationsChange,
  onViewAllOrders,
}: WindowClosedContentProps) {
  // Tick every second for the countdown.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const { hours, mins, secs } = diffParts(nextOpenAt, now);

  return (
    <View>
      {/* 1. Countdown card */}
      <View style={styles.countdownCard}>
        <Text style={styles.moon}>🌙</Text>
        <Text style={styles.ccTitle}>Window Closed for Today</Text>
        <Text style={styles.ccSub}>Next ordering window opens in</Text>

        <View style={styles.timerRow}>
          <TimeUnit value={pad2(hours)} label="Hours" />
          <TimeUnit value={pad2(mins)}  label="Mins"  />
          <TimeUnit value={pad2(secs)}  label="Secs"  />
        </View>

        <View style={styles.windowPill}>
          <Text style={styles.windowPillText}>
            Window: <Text style={styles.windowPillStrong}>{openTime} – {closeTime}</Text> daily
          </Text>
        </View>
      </View>

      {/* 2. Today's Activity */}
      {todaysOrders.length > 0 && (
        <View style={styles.todayCard}>
          <View style={styles.tsHead}>
            <Text style={styles.tsHeadTitle}>Today's Activity</Text>
            {onViewAllOrders && (
              <TouchableOpacity onPress={onViewAllOrders} activeOpacity={0.7}>
                <Text style={styles.tsHeadLink}>View all</Text>
              </TouchableOpacity>
            )}
          </View>

          {todaysOrders.map((order, idx) => {
            const isLast = idx === todaysOrders.length - 1;
            return (
              <View
                key={order.id}
                style={[styles.orderRow, isLast && styles.orderRowLast]}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.orderId} numberOfLines={1}>
                    #{order.id.slice(0, 16).toUpperCase()}
                  </Text>
                  <Text style={styles.orderTime}>
                    Today · {formatOrderTime(order.createdAt)} · {order.itemCount} items
                  </Text>
                </View>
                <View style={{ alignItems: "flex-end" }}>
                  <Text style={styles.orderAmount}>
                    ₹ {order.grandTotal.toFixed(2)}
                  </Text>
                  <Text
                    style={[
                      styles.orderStatus,
                      !isPaid(order.status) && { color: colors.mutedForeground },
                    ]}
                  >
                    {isPaid(order.status) ? "✓ Paid" : order.status}
                  </Text>
                </View>
              </View>
            );
          })}
        </View>
      )}

      {/* 3. Notification opt-in */}
      <View style={styles.notifCard}>
        <Text style={styles.notifBell}>🔔</Text>
        <View style={{ flex: 1 }}>
          <Text style={styles.notifTitle}>Get notified at 5:55 AM</Text>
          <Text style={styles.notifSub}>
            We'll remind you 5 min before window opens
          </Text>
        </View>
        <Switch
          value={notificationsEnabled}
          onValueChange={onNotificationsChange}
          trackColor={{ false: colors.ink5, true: colors.primary }}
          thumbColor={colors.card}
          ios_backgroundColor={colors.ink5}
        />
      </View>
    </View>
  );
}

// Time-unit tile -------------------------------------------------------

function TimeUnit({ value, label }: { value: string; label: string }) {
  return (
    <View style={styles.timeUnit}>
      <Text style={styles.tuVal}>{value}</Text>
      <Text style={styles.tuLbl}>{label}</Text>
    </View>
  );
}

// Styles ---------------------------------------------------------------

const styles = StyleSheet.create({
  // Countdown card
  countdownCard: {
    backgroundColor: colors.card,
    borderRadius: 18,
    padding: 20,
    marginTop: 12,
    marginHorizontal: 12,
    alignItems: "center",
    ...shadows.md,
  },
  moon: {
    fontSize: 40,
    marginBottom: 9,
  },
  ccTitle: {
    fontFamily: fonts.headingExtra,
    fontSize: 13,
    color: colors.foreground,
    textAlign: "center",
  },
  ccSub: {
    fontSize: 10,
    fontFamily: fonts.medium,
    color: colors.mutedForeground,
    marginTop: 3,
    lineHeight: 15,
    textAlign: "center",
  },
  timerRow: {
    flexDirection: "row",
    gap: 7,
    justifyContent: "center",
    marginTop: 14,
  },
  timeUnit: {
    backgroundColor: colors.background,
    borderRadius: 11,
    paddingVertical: 9,
    paddingHorizontal: 12,
    minWidth: 48,
    alignItems: "center",
  },
  tuVal: {
    fontFamily: fonts.headingBlack,
    fontSize: 18,
    color: colors.primary,
  },
  tuLbl: {
    fontSize: 7,
    fontFamily: fonts.bold,
    color: colors.mutedForeground,
    textTransform: "uppercase",
    letterSpacing: 0.4,
    marginTop: 2,
  },
  windowPill: {
    backgroundColor: colors.primaryLight,
    borderRadius: 7,
    paddingVertical: 9,
    paddingHorizontal: 12,
    marginTop: 12,
    alignSelf: "stretch",
  },
  windowPillText: {
    fontSize: 10,
    fontFamily: fonts.semibold,
    color: colors.primary,
    textAlign: "center",
  },
  windowPillStrong: {
    fontFamily: fonts.extrabold,
  },

  // Today's Activity card
  todayCard: {
    backgroundColor: colors.card,
    borderRadius: 14,
    padding: 12,
    marginTop: 12,
    marginHorizontal: 12,
    ...shadows.sm,
  },
  tsHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 9,
  },
  tsHeadTitle: {
    fontSize: 11,
    fontFamily: fonts.extrabold,
    color: colors.foreground,
  },
  tsHeadLink: {
    fontSize: 10,
    fontFamily: fonts.bold,
    color: colors.primary,
  },
  orderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    paddingVertical: 7,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  orderRowLast: {
    borderBottomWidth: 0,
  },
  orderId: {
    fontSize: 10,
    fontFamily: fonts.bold,
    color: colors.foreground,
  },
  orderTime: {
    fontSize: 9,
    fontFamily: fonts.medium,
    color: colors.mutedForeground,
    marginTop: 1,
  },
  orderAmount: {
    fontSize: 11,
    fontFamily: fonts.headingBlack,
    color: colors.primary,
  },
  orderStatus: {
    fontSize: 8,
    fontFamily: fonts.bold,
    color: colors.success,
    marginTop: 1,
  },

  // Notification opt-in card
  notifCard: {
    backgroundColor: colors.primaryLight,
    borderWidth: 1.5,
    borderColor: colors.primaryLight2,
    borderRadius: 14,
    padding: 12,
    marginTop: 10,
    marginHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
  },
  notifBell: {
    fontSize: 22,
  },
  notifTitle: {
    fontSize: 11,
    fontFamily: fonts.extrabold,
    color: colors.primary,
  },
  notifSub: {
    fontSize: 9,
    fontFamily: fonts.medium,
    color: colors.mutedForeground,
    marginTop: 2,
  },
});