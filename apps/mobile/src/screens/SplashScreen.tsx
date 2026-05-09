import React, { useEffect, useRef, useState } from "react";
import {
  Animated,
  Easing,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  colors,
  cssAngleToPoints,
  fonts,
  gradients,
} from "../lib/theme";

/**
 * SplashScreen - mockup screen 01.
 *
 * Mockup CSS (dealer-app.html lines 58-75, 405-431):
 * .splash : full screen, gradient bg (handled by gradients.splash)
 * .splash-grid : repeating-linear-gradient grid 40px - rgba(255,255,255,0.025)
 * .splash-c1 : 280x280 rgba(255,255,255,0.04) circle, top:-80, right:-80
 * .splash-c2 : 180x180 rgba(20,200,180,0.08) circle, bottom:110, left:-55
 * .splash-top : padding 52px 26px 0
 * logo-ring : 68x68, 20r, rgba(255,255,255,0.12), 2px border 0.2 white, font 32, blur 8px
 * splash-org : 12px Unbounded ExtraBold, 0.9 white
 * splash-sub : 10px 600, 0.45 white, uppercase, letter-spacing 1.5
 * .splash-hero : flex 1, centered
 * splash-truck : 66px, drop-shadow
 * headline : 18px Unbounded Black, white, line 1.3
 * headline em : color #FCD34D
 * tagline : 11px 500, 0.55 white
 * .splash-bottom : padding 0 22px 32px, gap 9px
 * btn-white : white bg, brand text, 14r, 14p, 14/800
 * btn-ghost : rgba(255,255,255,0.1), 1.5px border 0.2 white, 14r, 12p, 12/700
 * lang-row : gap 7, center, mt 3
 * lang-btn : 10/700 rgba(255,255,255,0.5), padding 3/7, 5r
 * lang-btn.active : color 0.9 white, bg rgba(255,255,255,0.1)
 *
 * Animation: scale-in entry on logo + truck (per spec 5.1 "scale 0.9 -> 1, 600ms ease-out").
 */
interface SplashScreenProps {
  onLogin: () => void;
}

type Lang = "en" | "kn";

export default function SplashScreen({ onLogin }: SplashScreenProps) {
  const insets = useSafeAreaInsets();
  const [lang, setLang] = useState<Lang>("en");

  // Scale-in animation for the logo ring + truck (spec 5.1)
  const scaleAnim = useRef(new Animated.Value(0.9)).current;
  const opacityAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(scaleAnim, {
        toValue: 1,
        duration: 600,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(opacityAnim, {
        toValue: 1,
        duration: 500,
        useNativeDriver: true,
      }),
    ]).start();
  }, [scaleAnim, opacityAnim]);

  const { colors: gradColors, locations, angle } = gradients.splash;
  const { start, end } = cssAngleToPoints(angle);

  return (
    <LinearGradient
      colors={gradColors as unknown as [string, string, string]}
      locations={locations as unknown as [number, number, number]}
      start={start}
      end={end}
      style={styles.root}
    >
      {/* Decorative circles */}
      <View style={styles.c1} />
      <View style={styles.c2} />

      {/* TOP - Logo + Org info */}
      <Animated.View
        style={[
          styles.top,
          { paddingTop: Math.max(insets.top + 12, 52) },
          { opacity: opacityAnim, transform: [{ scale: scaleAnim }] },
        ]}
      >
        <View style={styles.logoRing}>
          <Text style={styles.logoEmoji}>🐄</Text>
        </View>
        <Text style={styles.org}>Haveri Milk Union</Text>
        <Text style={styles.sub}>Karnataka · Est. 1984</Text>
      </Animated.View>

      {/* HERO - Centered headline */}
      <View style={styles.hero}>
        <Animated.Text
          style={[
            styles.truck,
            { transform: [{ scale: scaleAnim }] },
          ]}
        >
          🚚
        </Animated.Text>
        <Text style={styles.headline}>
          Order fresh dairy.
          {"\n"}
          <Text style={styles.headlineAccent}>Every morning.</Text>
        </Text>
        <Text style={styles.tagline}>
          Digital indent system for{"\n"}registered dealer agencies
        </Text>
      </View>

      {/* BOTTOM - CTAs + Language toggle */}
      <View
        style={[
          styles.bottom,
          { paddingBottom: Math.max(insets.bottom + 12, 32) },
        ]}
      >
        <TouchableOpacity
          style={styles.btnWhite}
          activeOpacity={0.85}
          onPress={onLogin}
          accessibilityRole="button"
        >
          <Text style={styles.btnWhiteText}>Login as Dealer →</Text>
        </TouchableOpacity>

        <View style={styles.langRow}>
          <TouchableOpacity
            onPress={() => setLang("en")}
            activeOpacity={0.7}
            style={[styles.langBtn, lang === "en" && styles.langBtnActive]}
          >
            <Text
              style={[styles.langText, lang === "en" && styles.langTextActive]}
            >
              English
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => setLang("kn")}
            activeOpacity={0.7}
            style={[styles.langBtn, lang === "kn" && styles.langBtnActive]}
          >
            <Text
              style={[styles.langText, lang === "kn" && styles.langTextActive]}
            >
              ಕನ್ನಡ
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </LinearGradient>
  );
}

// ════════════════════════════════════════════════════════════════════════
const styles = StyleSheet.create({
  root: {
    flex: 1,
    overflow: "hidden",
    position: "relative",
  },
  // Decorative circles
  c1: {
    position: "absolute",
    width: 280,
    height: 280,
    backgroundColor: "rgba(255,255,255,0.04)",
    borderRadius: 140,
    top: -80,
    right: -80,
  },
  c2: {
    position: "absolute",
    width: 180,
    height: 180,
    backgroundColor: "rgba(20,200,180,0.08)",
    borderRadius: 90,
    bottom: 110,
    left: -55,
  },
  // Top
  top: {
    paddingHorizontal: 26,
    zIndex: 1,
  },
  logoRing: {
    width: 68,
    height: 68,
    borderRadius: 20,
    backgroundColor: "rgba(255,255,255,0.12)",
    borderWidth: 2,
    borderColor: "rgba(255,255,255,0.2)",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 14,
  },
  logoEmoji: {
    fontSize: 32,
  },
  org: {
    fontFamily: fonts.headingExtra,
    fontSize: 12,
    color: "rgba(255,255,255,0.9)",
    letterSpacing: 0.5,
    lineHeight: 16.8,
  },
  sub: {
    fontSize: 10,
    fontFamily: fonts.semibold,
    color: "rgba(255,255,255,0.45)",
    marginTop: 3,
    letterSpacing: 1.5,
    textTransform: "uppercase",
  },
  // Hero
  hero: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 26,
    zIndex: 1,
  },
  truck: {
    fontSize: 66,
    marginBottom: 20,
  },
  headline: {
    fontFamily: fonts.headingBlack,
    fontSize: 18,
    color: colors.primaryForeground,
    textAlign: "center",
    lineHeight: 23.4,
    letterSpacing: -0.3,
  },
  headlineAccent: {
    color: colors.yellowAccent,
  },
  tagline: {
    fontSize: 11,
    fontFamily: fonts.medium,
    color: "rgba(255,255,255,0.55)",
    marginTop: 7,
    textAlign: "center",
    lineHeight: 16.5,
  },
  // Bottom
  bottom: {
    paddingHorizontal: 22,
    gap: 9,
    zIndex: 1,
  },
  btnWhite: {
    backgroundColor: colors.card,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: "center",
  },
  btnWhiteText: {
    fontSize: 14,
    fontFamily: fonts.extrabold,
    color: colors.primary,
    letterSpacing: -0.2,
  },
  // Language toggle
  langRow: {
    flexDirection: "row",
    gap: 7,
    justifyContent: "center",
    marginTop: 3,
  },
  langBtn: {
    paddingVertical: 3,
    paddingHorizontal: 7,
    borderRadius: 5,
  },
  langBtnActive: {
    backgroundColor: "rgba(255,255,255,0.1)",
  },
  langText: {
    fontSize: 10,
    fontFamily: fonts.bold,
    color: "rgba(255,255,255,0.5)",
  },
  langTextActive: {
    color: "rgba(255,255,255,0.9)",
  },
});