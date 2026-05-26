import React from "react";
import { StyleSheet, Text, TouchableOpacity } from "react-native";
import { fonts } from "../lib/theme";

/**
 * BackButton — a circular back button that stays visible on ANY
 * background (dark gradient header, light card, image, etc.).
 *
 * The previous Profile back button was a bare white "‹" — invisible
 * against the light-grey area it ended up on. This version always
 * has its own contrast: a semi-transparent dark disc with a light
 * arrow by default ("onDark"), or the inverse for light backgrounds.
 *
 *   <BackButton onPress={onBack} />                  // for dark headers
 *   <BackButton onPress={onBack} variant="onLight" /> // for light screens
 */

interface BackButtonProps {
  onPress: () => void;
  /** "onDark" (default) = light arrow on dark disc; "onLight" = inverse */
  variant?: "onDark" | "onLight";
  /** Absolute-position the button (for overlaying on a header) */
  absolute?: boolean;
  /** Top offset when absolute — pass the safe-area inset + a margin */
  top?: number;
}

export default function BackButton({
  onPress,
  variant = "onDark",
  absolute = false,
  top = 44,
}: BackButtonProps) {
  const v = VARIANTS[variant];
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityLabel="Go back"
      style={[
        styles.btn,
        { backgroundColor: v.bg, borderWidth: 1, borderColor: v.border },
        absolute && { position: "absolute", left: 12, top, zIndex: 20 },
      ]}
    >
      <Text style={[styles.arrow, { color: v.fg }]}>‹</Text>
    </TouchableOpacity>
  );
}

const VARIANTS = {
  onDark:  { bg: "rgba(0,0,0,0.45)", fg: "#FFFFFF", border: "rgba(255,255,255,0.30)" },
  onLight: { bg: "rgba(0,0,0,0.06)", fg: "#1A1A1A", border: "rgba(0,0,0,0.10)" },
} as const;

const styles = StyleSheet.create({
  btn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
  },
  arrow: {
    fontSize: 24,
    fontFamily: fonts.bold,
    lineHeight: 26,
    // Nudge the glyph optically centered
    marginLeft: -2,
  },
});