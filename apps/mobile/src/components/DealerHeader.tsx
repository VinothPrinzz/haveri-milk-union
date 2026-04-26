import React from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  colors,
  fonts,
  gradients,
  cssAngleToPoints,
} from "../lib/theme";
import LivePulseDot from "./LivePulseDot";
import type { WindowState } from "../lib/types";

/**
 * DealerHeader — the gradient header on DealerDashboard.
 *
 * Mockup CSS (dealer-app.html lines 103-132, 368, 603-618, 680-691):
 * .home-hdr { background: linear-gradient(155deg, #1448CC, #0D2B8F); padding: 0 16px 14px }
 * .home-hdr::after (decorative) { 170×170 rgba(255,255,255,0.05); top:-55; right:-35 }
 * .hdr-row1 { padding-top: 38px; margin-bottom: 11px }
 * .hdr-greeting { font-size: 10px; color: rgba(255,255,255,0.6) }
 * .hdr-name { font-family: Unbounded; font-size: 14px; font-weight: 800; color: white }
 * .hdr-notif { 34×34 rgba(255,255,255,0.12); border-radius: 11px; font-size: 16px }
 * .hdr-avatar { 34×34 rgba(255,255,255,0.15); border-radius: 11px; font-size: 15px }
 * .notif-badge { 7×7; top: 6px; right: 6px; background: #EF4444 }
 * .loc-chip { rgba(255,255,255,0.12); border-radius: 999px; padding: 6px 11px;
 * border: 1px solid rgba(255,255,255,0.15); margin-bottom: 12px }
 *
 * Three window states share the same header shell but swap:
 * • gradient colors
 * • window banner content + colors
 * • avatar visibility (hidden when closed)
 * • greeting dim level (0.6 when open/warning, 0.5 when closed)
 */
interface DealerHeaderProps {
  dealerName: string;
  locationLabel: string;
  windowState: WindowState; // "open" | "warning" | "closed"
  remainingSeconds: number; // from useWindowStatus
  openTime: string; // "06:00"
  closeTime: string; // "08:00"
  hasNotification?: boolean;
  onLocationPress: () => void;
  onNotificationPress: () => void;
}

// ── Gradient selection ──────────────────────────────────────────────────
function selectGradient(state: WindowState) {
  if (state === "warning") return gradients.headerClosing;
  if (state === "closed") return gradients.headerClosed;
  return gradients.headerOpen;
}

// ── Greeting by time of day (IST is implicit for Haveri) ────────────────
function currentGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning,";
  if (h < 17) return "Good afternoon,";
  return "Good evening,";
}

// ── Countdown formatting ────────────────────────────────────────────────
/** Format remainingSeconds into "HH:MM" for the live-banner timer. */
function formatHHMM(totalSeconds: number): string {
  if (totalSeconds <= 0) return "00:00";
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** "X min left" for the closing-soon banner's secondary line. */
function formatMinutesLeft(totalSeconds: number): string {
  const m = Math.max(0, Math.ceil(totalSeconds / 60));
  return `${m} min left`;
}

// ── Main ────────────────────────────────────────────────────────────────
export default function DealerHeader({
  dealerName,
  locationLabel,
  windowState,
  remainingSeconds,
  openTime,
  closeTime,
  hasNotification = false,
  onLocationPress,
  onNotificationPress,
}: DealerHeaderProps) {
  const insets = useSafeAreaInsets();
  const { colors: gradColors, angle } = selectGradient(windowState);
  const { start, end } = cssAngleToPoints(angle);

  // Row 1 top space: mockup shows 38px from the top of the screen to the greeting.
  const row1Top = Math.max(insets.top + 4, 38);

  return (
    <LinearGradient
      colors={gradColors as unknown as [string, string]}
      start={start}
      end={end}
      style={styles.root}
    >
      {/* Decorative translucent circle, top-right */}
      <View style={styles.decorCircle} />

      {/* Row 1: Greeting + agency name ←→ bell + avatar */}
      <View style={[styles.row1, { paddingTop: row1Top }]}>
        <View style={{ flex: 1 }}>
          <Text
            style={[
              styles.greeting,
              windowState === "closed" && { color: "rgba(255,255,255,0.5)" },
            ]}
          >
            {currentGreeting()}
          </Text>
          <Text style={styles.name} numberOfLines={1}>
            {dealerName} 🏪
          </Text>
        </View>
        <View style={styles.rightButtons}>
          <TouchableOpacity
            onPress={onNotificationPress}
            activeOpacity={0.7}
            style={styles.bellBtn}
            accessibilityLabel="Notifications"
          >
            <Text style={styles.bellIcon}>🔔</Text>
            {hasNotification && <View style={styles.notifBadge} />}
          </TouchableOpacity>
        </View>
      </View>

      {/* Location chip */}
      <TouchableOpacity onPress={onLocationPress} activeOpacity={0.7} style={styles.locChip}>
        <Text style={styles.locChipIcon}>📍</Text>
        <Text style={styles.locChipText} numberOfLines={1}>
          {locationLabel}
        </Text>
        <Text style={styles.locChipCaret}>▾</Text>
      </TouchableOpacity>

      {/* Window banner — 3 state variants */}
      <WindowBanner
        state={windowState}
        remainingSeconds={remainingSeconds}
        openTime={openTime}
        closeTime={closeTime}
      />
    </LinearGradient>
  );
}

// ════════════════════════════════════════════════════════════════════════
// Window banner — inlined here because it's tightly coupled to header state
// ════════════════════════════════════════════════════════════════════════
interface WindowBannerProps {
  state: WindowState;
  remainingSeconds: number;
  openTime: string;
  closeTime: string;
}

function WindowBanner({ state, remainingSeconds, openTime, closeTime }: WindowBannerProps) {
  if (state === "open") return <BannerOpen remainingSeconds={remainingSeconds} closeTime={closeTime} />;
  if (state === "warning") return <BannerWarning remainingSeconds={remainingSeconds} closeTime={closeTime} />;
  return <BannerClosed openTime={openTime} />;
}

// ── Open variant ────────────────────────────────────────────────────────
function BannerOpen({ remainingSeconds, closeTime }: { remainingSeconds: number; closeTime: string }) {
  return (
    <View style={bannerStyles.openWrap}>
      <LivePulseDot color={colors.dotGreen} speed="slow" size={7} />
      <View style={bannerStyles.text}>
        <Text style={bannerStyles.twt1}>Ordering window is OPEN</Text>
        <Text style={bannerStyles.twt2}>Place your indent before {closeTime}</Text>
      </View>
      <View style={bannerStyles.timerBox}>
        <Text style={bannerStyles.timerVal}>{formatHHMM(remainingSeconds)}</Text>
        <Text style={bannerStyles.timerLbl}>Hrs left</Text>
      </View>
    </View>
  );
}

// ── Warning (closing soon) variant ─────────────────────────────────────
function BannerWarning({ remainingSeconds, closeTime }: { remainingSeconds: number; closeTime: string }) {
  return (
    <View style={bannerStyles.closingWrap}>
      <LivePulseDot color={colors.yellowAccent} speed="fast" size={7} />
      <View style={bannerStyles.text}>
        <Text style={[bannerStyles.twt1, { color: "rgba(255,255,255,0.7)" }]}>
          ⚠️ Closing soon!
        </Text>
        <Text style={bannerStyles.twt2}>
          Order before {closeTime} · {formatMinutesLeft(remainingSeconds)}
        </Text>
      </View>
      <View style={bannerStyles.timerBox}>
        <Text style={bannerStyles.timerVal}>
          {String(Math.max(0, Math.floor(remainingSeconds / 60))).padStart(2, "0")}:
          {String(Math.max(0, remainingSeconds % 60)).padStart(2, "0")}
        </Text>
        <Text style={bannerStyles.timerLbl}>HURRY!</Text>
      </View>
    </View>
  );
}

// ── Closed variant ──────────────────────────────────────────────────────
function BannerClosed({ openTime }: { openTime: string }) {
  return (
    <View style={bannerStyles.closedWrap}>
      <LivePulseDot color={colors.dotRed} speed="off" size={7} />
      <View style={bannerStyles.text}>
        <Text style={bannerStyles.twt1}>Ordering window is closed</Text>
        <Text style={[bannerStyles.twt2, { color: "rgba(255,255,255,0.8)" }]}>
          Opens tomorrow at {openTime}
        </Text>
      </View>
      <View style={bannerStyles.timerBoxClosed}>
        <Text style={[bannerStyles.timerVal, { color: colors.yellowAccent2 }]}>
          {"--:--"}
        </Text>
        <Text style={[bannerStyles.timerLbl, { color: "rgba(252,165,165,0.6)" }]}>hrs away</Text>
      </View>
    </View>
  );
}

// ════════════════════════════════════════════════════════════════════════
// Styles
// ════════════════════════════════════════════════════════════════════════
const styles = StyleSheet.create({
  root: {
    paddingHorizontal: 16,
    paddingBottom: 14,
    position: "relative",
    overflow: "hidden",
  },
  decorCircle: {
    position: "absolute",
    width: 170,
    height: 170,
    top: -55,
    right: -35,
    borderRadius: 85,
    backgroundColor: colors.white05,
  },
  row1: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 11,
  },
  greeting: {
    fontSize: 10,
    fontFamily: fonts.semibold,
    color: "rgba(255,255,255,0.6)",
  },
  name: {
    fontFamily: fonts.headingExtra,
    fontSize: 14,
    color: colors.primaryForeground,
    marginTop: 1,
  },
  rightButtons: {
    flexDirection: "row",
    gap: 7,
    alignItems: "center",
    marginLeft: 8,
  },
  bellBtn: {
    position: "relative",
    width: 34,
    height: 34,
    backgroundColor: colors.white12,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
  },
  bellIcon: { fontSize: 16 },
  notifBadge: {
    position: "absolute",
    top: 6,
    right: 6,
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: colors.destructive,
  },
  locChip: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: colors.white12,
    borderRadius: 999,
    paddingVertical: 6,
    paddingHorizontal: 11,
    borderWidth: 1,
    borderColor: colors.white15,
    marginBottom: 12,
  },
  locChipIcon: { fontSize: 11 },
  locChipText: {
    fontSize: 11,
    fontFamily: fonts.semibold,
    color: colors.primaryForeground,
  },
  locChipCaret: {
    fontSize: 8,
    color: "rgba(255,255,255,0.6)",
    marginLeft: 2,
  },
});

// ── Banner styles (kept separate for scan-ability) ─────────────────────
const BANNER_BASE = {
  flexDirection: "row" as const,
  alignItems: "center" as const,
  gap: 9,
  borderRadius: 14,
  paddingVertical: 11,
  paddingHorizontal: 13,
  borderWidth: 1,
};

const bannerStyles = StyleSheet.create({
  openWrap: {
    ...BANNER_BASE,
    backgroundColor: colors.white12,
    borderColor: "rgba(255,255,255,0.2)",
  },
  closingWrap: {
    ...BANNER_BASE,
    backgroundColor: "rgba(217,119,6,0.2)",
    borderColor: "rgba(217,119,6,0.4)",
  },
  closedWrap: {
    ...BANNER_BASE,
    backgroundColor: "rgba(220,38,38,0.15)",
    borderColor: "rgba(220,38,38,0.25)",
  },
  text: {
    flex: 1,
  },
  twt1: {
    fontSize: 10,
    fontFamily: fonts.semibold,
    color: "rgba(255,255,255,0.8)",
  },
  twt2: {
    fontSize: 11,
    fontFamily: fonts.extrabold,
    color: colors.primaryForeground,
    marginTop: 1,
  },
  timerBox: {
    backgroundColor: "rgba(252,211,77,0.2)",
    borderWidth: 1.5,
    borderColor: "rgba(252,211,77,0.4)",
    borderRadius: 7,
    paddingVertical: 5,
    paddingHorizontal: 9,
    alignItems: "center",
  },
  timerBoxClosed: {
    backgroundColor: "rgba(220,38,38,0.15)",
    borderWidth: 1.5,
    borderColor: "rgba(220,38,38,0.3)",
    borderRadius: 7,
    paddingVertical: 5,
    paddingHorizontal: 9,
    alignItems: "center",
  },
  timerVal: {
    fontFamily: fonts.headingExtra,
    fontSize: 12,
    color: colors.yellowAccent,
  },
  timerLbl: {
    fontSize: 7,
    fontFamily: fonts.bold,
    color: "rgba(252,211,77,0.7)",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
});