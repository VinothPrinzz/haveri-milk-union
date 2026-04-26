import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { colors, fonts } from "../lib/theme";

/**
 * ClosingSoonBanner — slim amber warning that appears above the search bar
 * when windowState === "warning" (spec §6.10).
 *
 * Mockup inline style (dealer-app.html lines 620-627):
 *   margin: 10px 12px 0;
 *   background: #FEF3C7;
 *   border: 1.5px solid #FDE68A;
 *   border-radius: 11px;
 *   padding: 9px 12px;
 *   display: flex; align-items: center; gap: 7px;
 *
 *   icon  span: font-size: 16px ("clock" emoji)
 *   line1 div : font-size: 10px; weight: 800; color: #D97706
 *   line2 div : font-size:  9px; weight: 500; color: #92400E; margin-top: 2px
 *
 * Pluralization is handled here so the parent only needs to pass remaining minutes.
 */

interface ClosingSoonBannerProps {
  /** Minutes remaining in the window (round up from seconds before passing). */
  minutesLeft: number;
  /** Time the window closes, e.g. "8:00 AM". Used in the secondary line. */
  openTimeNextDay?: string;
}

export default function ClosingSoonBanner({
  minutesLeft,
  openTimeNextDay = "tomorrow 6 AM",
}: ClosingSoonBannerProps) {
  const safeMinutes = Math.max(0, Math.floor(minutesLeft));
  const minLabel = safeMinutes === 1 ? "minute" : "minutes";

  return (
    <View style={styles.wrap}>
      <Text style={styles.icon}>⏱️</Text>
      <View style={styles.text}>
        <Text style={styles.line1}>
          Window closing in {safeMinutes} {minLabel}!
        </Text>
        <Text style={styles.line2}>
          Place your indent now or wait until {openTimeNextDay}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginTop: 10,
    marginHorizontal: 12,
    backgroundColor: colors.warningLight,
    borderWidth: 1.5,
    borderColor: colors.warningBorder,
    borderRadius: 11,
    paddingVertical: 9,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
  },
  icon: {
    fontSize: 16,
  },
  text: {
    flex: 1,
  },
  line1: {
    fontSize: 10,
    fontFamily: fonts.extrabold,
    color: colors.warning,
  },
  line2: {
    fontSize: 9,
    fontFamily: fonts.medium,
    color: colors.windowWarningSolid,
    marginTop: 2,
  },
});