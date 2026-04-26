import React, { useEffect, useRef } from "react";
import { Animated, StyleSheet, View } from "react-native";
import { colors } from "../lib/theme";

/**
 * LivePulseDot — the pulsing colored circle used in:
 *   • DealerHeader's window-open banner (green, 1.8s)
 *   • DealerHeader's window-closing banner (yellow, 0.8s — "livepulse2" in mockup)
 *   • OrdersScreen active-order hero card (green, 1.8s)
 *
 * Mockup CSS:
 *   .tw-live-dot { 7×7 #4ADE80; animation: livepulse 1.8s ease-in-out infinite }
 *   @keyframes livepulse {
 *     0%,100% { box-shadow: 0 0 0 0 rgba(74,222,128,0.6) }
 *     50%     { box-shadow: 0 0 0 6px rgba(74,222,128,0) }
 *   }
 *
 * React Native doesn't animate box-shadow. We fake it with an overlaid View that
 * scales from 1 → ~2.7 while fading opacity 0.6 → 0 on a loop. Same visual.
 */

export type PulseSpeed = "slow" | "fast" | "off";

interface LivePulseDotProps {
  color?: string;
  size?: number;
  speed?: PulseSpeed;
  style?: object;
}

export default function LivePulseDot({
  color = colors.dotGreen,
  size = 7,
  speed = "slow",
  style,
}: LivePulseDotProps) {
  const scale   = useRef(new Animated.Value(1)).current;
  const opacity = useRef(new Animated.Value(0.6)).current;

  useEffect(() => {
    if (speed === "off") return;

    const duration = speed === "fast" ? 800 : 1800;

    const loop = Animated.loop(
      Animated.parallel([
        Animated.sequence([
          Animated.timing(scale, { toValue: 2.7, duration, useNativeDriver: true }),
          Animated.timing(scale, { toValue: 1,   duration: 0, useNativeDriver: true }),
        ]),
        Animated.sequence([
          Animated.timing(opacity, { toValue: 0, duration, useNativeDriver: true }),
          Animated.timing(opacity, { toValue: 0.6, duration: 0, useNativeDriver: true }),
        ]),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [scale, opacity, speed]);

  return (
    <View style={[styles.wrap, { width: size, height: size }, style]}>
      {/* Solid core dot */}
      <View style={[styles.core, { width: size, height: size, backgroundColor: color }]} />
      {/* Pulsing ring — only when not "off" */}
      {speed !== "off" && (
        <Animated.View
          style={[
            styles.ring,
            {
              width: size,
              height: size,
              backgroundColor: color,
              transform: [{ scale }],
              opacity,
            },
          ]}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
  },
  core: {
    borderRadius: 999,
    zIndex: 1,
  },
  ring: {
    position: "absolute",
    borderRadius: 999,
  },
});