import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  Dimensions,
  Easing,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
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
  shadows,
} from "../lib/theme";
import { useAuthStore } from "../store/auth";
import { ApiError } from "../lib/api";

/**
 * LoginScreen - mockup screens 02-03 (the OTP login flow).
 *
 * Mockup CSS reference (dealer-app.html lines 78-99, 434-484):
 *   .otp-page    : flex column, white bg
 *   .otp-header  : 145deg gradient brand->#0D2B8F, padding 42 22 28
 *     ::after    : 180x180 white circle, top:-70 right:-45
 *   .otp-back    : 30x30 rgba(255,255,255,0.15), 9r, font 15
 *   .otp-header h2 : 16px Unbounded ExtraBold white, line 1.3
 *   .otp-header p  : 11px 500 rgba(255,255,255,0.65), mt 5
 *   .otp-body    : padding 20, scroll
 *   .form-label  : 9px 800 uppercase letter-spacing 1, ink3, mb 5
 *   .form-input  : full-width #EEF2FA bg, 2px border, 11r, padding 11/12, 13/600
 *     .focused   : border brand, bg brand-light
 *     fi-icon    : font 15
 *     fi-divider : 1x16, var(--border)
 *     fi-prefix  : 12/700 ink2
 *   .otp-boxes   : flex gap 7 mb 18
 *   .otp-box     : flex 1, h 46, bg, 2px border, 11r, font 18 black Unbounded
 *     .f        : filled - brand-l bg, brand border, brand text
 *     .a        : active focus - white, brand border, 3px ring 0.12
 *   .btn-brand   : full-width brand, 14r, padding 13, 14/800
 *   .resend      : center, 11px 500 ink3, mt 10; span = brand 700
 *   .biometric-row: green-light bg, 1.5px #bbf7d0, 11r, padding 10, gap 9, mt 14
 *
 * Sub-states (handled here without react-router because this is one screen):
 *   "phone" - enter mobile number, Send OTP
 *   "otp"   - enter 6 digits, Verify & Login (slide in from right per spec)
 *   "biometric" - shown as a card after successful entry, before nav (auto-skipped if not supported)
 *
 * App.tsx props (from existing): { onSuccess, onBack }
 * We add nothing - keep the contract identical so App.tsx doesn't change.
 */

interface LoginScreenProps {
  onSuccess: () => void;
  onBack: () => void;
}

type SubState = "phone" | "otp";

const SCREEN_WIDTH = Dimensions.get("window").width;
const RESEND_COUNTDOWN_S = 38;

export default function LoginScreen({ onSuccess, onBack }: LoginScreenProps) {
  const insets = useSafeAreaInsets();
  const requestOtp = useAuthStore((s) => s.requestOtp);
  const verifyOtp  = useAuthStore((s) => s.verifyOtp);

  // Sub-state
  const [subState, setSubState] = useState<SubState>("phone");

  // Phone state
  const [phone, setPhone] = useState("");
  const [phoneFocused, setPhoneFocused] = useState(false);

  // OTP state
  const [otp, setOtp] = useState<string[]>(["", "", "", "", "", ""]);
  const [activeOtpIdx, setActiveOtpIdx] = useState(0);
  const otpRefs = useRef<Array<TextInput | null>>([]);

  // Resend countdown
  const [resendIn, setResendIn] = useState(0);

  // Loading + error
  const [loading, setLoading] = useState(false);

  // Slide animation between phone -> otp (-20 -> 20 horizontal per spec)
  const slideX = useRef(new Animated.Value(0)).current;
  const opacity = useRef(new Animated.Value(1)).current;

  // Tick resend countdown
  useEffect(() => {
    if (resendIn <= 0) return;
    const id = setInterval(() => setResendIn((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(id);
  }, [resendIn]);

  // ── Helpers ────────────────────────────────────────────────────────

  const isValidPhone = phone.length === 10;
  const isValidOtp = otp.every((d) => d.length === 1);

  const slideToOtp = () => {
    Animated.parallel([
      Animated.timing(slideX, {
        toValue: -SCREEN_WIDTH,
        duration: 240,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(opacity, {
        toValue: 0,
        duration: 200,
        useNativeDriver: true,
      }),
    ]).start(() => {
      setSubState("otp");
      slideX.setValue(SCREEN_WIDTH);
      opacity.setValue(0);
      Animated.parallel([
        Animated.timing(slideX, {
          toValue: 0,
          duration: 240,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: 220,
          useNativeDriver: true,
        }),
      ]).start(() => {
        // Focus the first OTP input once the slide finishes
        setTimeout(() => otpRefs.current[0]?.focus(), 50);
      });
    });
  };

  const slideToPhone = () => {
    Animated.parallel([
      Animated.timing(slideX, {
        toValue: SCREEN_WIDTH,
        duration: 240,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(opacity, {
        toValue: 0,
        duration: 200,
        useNativeDriver: true,
      }),
    ]).start(() => {
      setSubState("phone");
      slideX.setValue(-SCREEN_WIDTH);
      opacity.setValue(0);
      Animated.parallel([
        Animated.timing(slideX, {
          toValue: 0,
          duration: 240,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: 220,
          useNativeDriver: true,
        }),
      ]).start();
    });
  };

  // ── Actions ────────────────────────────────────────────────────────

  const handleSendOtp = async () => {
    if (!isValidPhone || loading) return;
    setLoading(true);
    try {
      await requestOtp(phone);
      setResendIn(RESEND_COUNTDOWN_S);
      slideToOtp();
    } catch (err) {
      const msg = err instanceof ApiError
        ? err.message
        : "Could not send OTP. Try again.";
      Alert.alert("Error", msg);
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    if (resendIn > 0 || loading) return;
    setLoading(true);
    try {
      await requestOtp(phone);
      setResendIn(RESEND_COUNTDOWN_S);
      setOtp(["", "", "", "", "", ""]);
      setActiveOtpIdx(0);
      otpRefs.current[0]?.focus();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Resend failed.";
      Alert.alert("Error", msg);
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async () => {
    if (!isValidOtp || loading) return;
    setLoading(true);
    try {
      const ok = await verifyOtp(phone, otp.join(""));
      if (ok) {
        onSuccess();
      } else {
        Alert.alert("Login Failed", "Invalid OTP. Please try again.");
      }
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Verification failed.";
      Alert.alert("Login Failed", msg);
    } finally {
      setLoading(false);
    }
  };

  // OTP input handlers
  const handleOtpChange = (idx: number, value: string) => {
    // Sanitize - only digits, max 1 char
    const cleaned = value.replace(/[^0-9]/g, "").slice(0, 1);
    const newOtp = [...otp];
    newOtp[idx] = cleaned;
    setOtp(newOtp);

    // Auto-advance
    if (cleaned && idx < 5) {
      otpRefs.current[idx + 1]?.focus();
      setActiveOtpIdx(idx + 1);
    } else if (cleaned && idx === 5 && newOtp.every((d) => d.length === 1)) {
      // Auto-submit on last digit
      setTimeout(() => handleVerify(), 100);
    }
  };

  const handleOtpKey = (idx: number, key: string) => {
    if (key === "Backspace" && !otp[idx] && idx > 0) {
      otpRefs.current[idx - 1]?.focus();
      setActiveOtpIdx(idx - 1);
    }
  };

  const handleBack = () => {
    if (subState === "otp") slideToPhone();
    else onBack();
  };

  // ── Render ─────────────────────────────────────────────────────────

  const { colors: gradColors, angle } = gradients.otpHeader;
  const { start, end } = cssAngleToPoints(angle);

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      {/* Gradient header */}
      <LinearGradient
        colors={gradColors as unknown as [string, string]}
        start={start}
        end={end}
        style={[
          styles.header,
          { paddingTop: Math.max(insets.top + 8, 42) },
        ]}
      >
        <View style={styles.headerDecor} />

        <TouchableOpacity
          onPress={handleBack}
          style={styles.backBtn}
          activeOpacity={0.7}
          accessibilityLabel="Go back"
        >
          <Text style={styles.backIcon}>←</Text>
        </TouchableOpacity>

        <Text style={styles.headerTitle}>
          {subState === "phone" ? "Dealer Login 👋" : "Verify OTP 🔐"}
        </Text>
        <Text style={styles.headerSub}>
          {subState === "phone"
            ? "Enter your mobile number linked to your agency account"
            : `We sent a 6-digit code to +91 ${phone}`}
        </Text>
      </LinearGradient>

      {/* Animated body - swaps between phone / otp */}
      <Animated.View
        style={[
          styles.body,
          { transform: [{ translateX: slideX }], opacity },
        ]}
      >
        <ScrollView
          contentContainerStyle={styles.bodyContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {subState === "phone" ? (
            <PhoneSubState
              phone={phone}
              setPhone={setPhone}
              focused={phoneFocused}
              setFocused={setPhoneFocused}
              isValid={isValidPhone}
              loading={loading}
              onSendOtp={handleSendOtp}
            />
          ) : (
            <OtpSubState
              otp={otp}
              activeIdx={activeOtpIdx}
              setActiveIdx={setActiveOtpIdx}
              otpRefs={otpRefs}
              onChange={handleOtpChange}
              onKey={handleOtpKey}
              onVerify={handleVerify}
              onResend={handleResend}
              resendIn={resendIn}
              isValid={isValidOtp}
              loading={loading}
            />
          )}
        </ScrollView>
      </Animated.View>
    </KeyboardAvoidingView>
  );
}

// ════════════════════════════════════════════════════════════════════════
// PhoneSubState
// ════════════════════════════════════════════════════════════════════════

interface PhoneSubProps {
  phone: string;
  setPhone: (s: string) => void;
  focused: boolean;
  setFocused: (b: boolean) => void;
  isValid: boolean;
  loading: boolean;
  onSendOtp: () => void;
}

function PhoneSubState({
  phone,
  setPhone,
  focused,
  setFocused,
  isValid,
  loading,
  onSendOtp,
}: PhoneSubProps) {
  return (
    <>
      {/* Mobile Number */}
      <View style={styles.formGroup}>
        <Text style={styles.formLabel}>Mobile Number</Text>
        <View
          style={[
            styles.formInput,
            focused && styles.formInputFocused,
          ]}
        >
          <Text style={styles.fiIcon}>🇮🇳</Text>
          <Text style={styles.fiPrefix}>+91</Text>
          <View style={styles.fiDivider} />
          <TextInput
            style={styles.fiInput}
            value={phone}
            onChangeText={(v) => setPhone(v.replace(/[^0-9]/g, "").slice(0, 10))}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder="98765 43210"
            placeholderTextColor={colors.ink4}
            keyboardType="number-pad"
            maxLength={10}
            autoComplete="tel"
            textContentType="telephoneNumber"
          />
        </View>
      </View>

      {/* Send OTP */}
      <TouchableOpacity
        style={[
          styles.btnBrand,
          (!isValid || loading) && styles.btnBrandDisabled,
        ]}
        activeOpacity={0.85}
        onPress={onSendOtp}
        disabled={!isValid || loading}
        accessibilityRole="button"
      >
        {loading ? (
          <ActivityIndicator color={colors.primaryForeground} />
        ) : (
          <Text style={styles.btnBrandText}>Send OTP →</Text>
        )}
      </TouchableOpacity>
    </>
  );
}

// ════════════════════════════════════════════════════════════════════════
// OtpSubState
// ════════════════════════════════════════════════════════════════════════

interface OtpSubProps {
  otp: string[];
  activeIdx: number;
  setActiveIdx: (n: number) => void;
  otpRefs: React.MutableRefObject<Array<TextInput | null>>;
  onChange: (idx: number, value: string) => void;
  onKey: (idx: number, key: string) => void;
  onVerify: () => void;
  onResend: () => void;
  resendIn: number;
  isValid: boolean;
  loading: boolean;
}

function OtpSubState({
  otp,
  activeIdx,
  setActiveIdx,
  otpRefs,
  onChange,
  onKey,
  onVerify,
  onResend,
  resendIn,
  isValid,
  loading,
}: OtpSubProps) {
  return (
    <>
      <Text style={styles.formLabel}>Enter 6-Digit OTP</Text>

      <View style={styles.otpBoxes}>
        {otp.map((digit, idx) => {
          const filled = digit.length === 1;
          const active = idx === activeIdx && !filled;
          return (
            <View
              key={idx}
              style={[
                styles.otpBox,
                filled && styles.otpBoxFilled,
                active && styles.otpBoxActive,
              ]}
            >
              <TextInput
                ref={(el) => { otpRefs.current[idx] = el; }}
                style={[styles.otpInput, filled && styles.otpInputFilled]}
                value={digit}
                onChangeText={(v) => onChange(idx, v)}
                onKeyPress={({ nativeEvent }) => onKey(idx, nativeEvent.key)}
                onFocus={() => setActiveIdx(idx)}
                keyboardType="number-pad"
                maxLength={1}
                selectTextOnFocus
                textContentType="oneTimeCode"
                accessibilityLabel={`OTP digit ${idx + 1}`}
              />
            </View>
          );
        })}
      </View>

      <TouchableOpacity
        style={[
          styles.btnBrand,
          (!isValid || loading) && styles.btnBrandDisabled,
        ]}
        activeOpacity={0.85}
        onPress={onVerify}
        disabled={!isValid || loading}
        accessibilityRole="button"
      >
        {loading ? (
          <ActivityIndicator color={colors.primaryForeground} />
        ) : (
          <Text style={styles.btnBrandText}>Verify & Login</Text>
        )}
      </TouchableOpacity>

      {/* Resend */}
      <View style={styles.resendRow}>
        <Text style={styles.resendText}>
          Didn't receive OTP?{" "}
          {resendIn > 0 ? (
            <Text style={styles.resendLink}>Resend in 0:{String(resendIn).padStart(2, "0")}</Text>
          ) : (
            <Text
              style={[styles.resendLink, styles.resendLinkActive]}
              onPress={onResend}
            >
              Resend OTP
            </Text>
          )}
        </Text>
      </View>

      {/* Biometric hint */}
      <View style={styles.biometricRow}>
        <Text style={styles.biometricEmoji}>🔐</Text>
        <Text style={styles.biometricText}>
          Use fingerprint / Face ID for quick login next time
        </Text>
        <Text style={styles.biometricEnable}>Enable</Text>
      </View>
    </>
  );
}

// ════════════════════════════════════════════════════════════════════════
// Styles
// ════════════════════════════════════════════════════════════════════════

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.card,
  },

  // Header ----------------------------------------------------------
  header: {
    paddingHorizontal: 22,                  // mockup
    paddingBottom: 28,
    overflow: "hidden",
    position: "relative",
  },
  headerDecor: {
    position: "absolute",
    width: 180,                             // mockup
    height: 180,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderRadius: 90,
    top: -70,
    right: -45,
  },
  backBtn: {
    width: 30,                              // mockup
    height: 30,
    backgroundColor: "rgba(255,255,255,0.15)",
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 14,
  },
  backIcon: {
    fontSize: 15,                           // mockup
    color: colors.primaryForeground,
    lineHeight: 17,
  },
  headerTitle: {
    fontFamily: fonts.headingExtra,
    fontSize: 16,                           // mockup
    color: colors.primaryForeground,
    lineHeight: 20.8,                       // 16 * 1.3
  },
  headerSub: {
    fontSize: 11,                           // mockup
    fontFamily: fonts.medium,
    color: "rgba(255,255,255,0.65)",
    marginTop: 5,
    lineHeight: 16.5,                       // 11 * 1.5
  },

  // Body ------------------------------------------------------------
  body: {
    flex: 1,
    backgroundColor: colors.card,
  },
  bodyContent: {
    padding: 20,
    paddingBottom: 40,
  },

  // Form ------------------------------------------------------------
  formGroup: {
    marginBottom: 16,
  },
  formLabel: {
    fontSize: 9,                            // mockup
    fontFamily: fonts.extrabold,
    color: colors.mutedForeground,
    textTransform: "uppercase",
    letterSpacing: 1,
    marginBottom: 5,
  },
  formInput: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: colors.background,
    borderWidth: 2,
    borderColor: colors.border,
    borderRadius: 11,
    paddingVertical: 11,                    // mockup
    paddingHorizontal: 12,
  },
  formInputFocused: {
    borderColor: colors.primary,
    backgroundColor: colors.primaryLight,
  },
  fiIcon: {
    fontSize: 15,                           // mockup
  },
  fiPrefix: {
    fontSize: 12,                           // mockup
    fontFamily: fonts.bold,
    color: colors.ink2,
  },
  fiDivider: {
    width: 1,
    height: 16,
    backgroundColor: colors.border,
  },
  fiInput: {
    flex: 1,
    fontSize: 13,
    fontFamily: fonts.semibold,
    color: colors.foreground,
    padding: 0,                              // RN default has internal padding
  },

  // Brand button (used in both states) ------------------------------
  btnBrand: {
    width: "100%",
    backgroundColor: colors.primary,
    borderRadius: 14,
    paddingVertical: 13,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 48,
  },
  btnBrandDisabled: {
    opacity: 0.5,
  },
  btnBrandText: {
    fontSize: 14,
    fontFamily: fonts.extrabold,
    color: colors.primaryForeground,
    letterSpacing: -0.2,
  },

  // OTP boxes -------------------------------------------------------
  otpBoxes: {
    flexDirection: "row",
    gap: 7,
    marginBottom: 18,
  },
  otpBox: {
    flex: 1,
    height: 46,
    backgroundColor: colors.background,
    borderWidth: 2,
    borderColor: colors.border,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
  },
  otpBoxFilled: {
    backgroundColor: colors.primaryLight,
    borderColor: colors.primary,
  },
  otpBoxActive: {
    backgroundColor: colors.card,
    borderColor: colors.primary,
    ...shadows.sm,                           // approximation of "0 0 0 3px rgba(20,72,204,0.12)"
  },
  otpInput: {
    width: "100%",
    height: "100%",
    textAlign: "center",
    fontSize: 18,
    fontFamily: fonts.headingBlack,
    color: colors.foreground,
    padding: 0,
  },
  otpInputFilled: {
    color: colors.primary,
  },

  // Resend ----------------------------------------------------------
  resendRow: {
    alignItems: "center",
    marginTop: 10,
  },
  resendText: {
    fontSize: 11,
    fontFamily: fonts.medium,
    color: colors.mutedForeground,
  },
  resendLink: {
    fontFamily: fonts.bold,
    color: colors.primary,
  },
  resendLinkActive: {
    textDecorationLine: "underline",
  },

  // Biometric hint --------------------------------------------------
  biometricRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    marginTop: 14,
    padding: 10,
    backgroundColor: colors.successLight,
    borderRadius: 11,
    borderWidth: 1.5,
    borderColor: colors.successBorder,
  },
  biometricEmoji: {
    fontSize: 20,
  },
  biometricText: {
    flex: 1,
    fontSize: 10,
    fontFamily: fonts.bold,
    color: colors.success,
  },
  biometricEnable: {
    fontSize: 11,
    fontFamily: fonts.bold,
    color: colors.success,
  },
});