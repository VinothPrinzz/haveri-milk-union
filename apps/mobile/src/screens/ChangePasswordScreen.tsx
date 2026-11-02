import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TextInputProps,
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
import { api, ApiError } from "../lib/api";

interface ChangePasswordScreenProps {
  /** Called after a successful change (and on the back arrow). */
  onBack: () => void;
}

interface OtpRequestResponse {
  maskedPhone: string;
  resendAfterSeconds: number;
}

/**
 * ChangePasswordScreen — OTP-verified password change.
 *
 * Step 1: dealer enters their username; the API texts a 6-digit OTP to the
 *         phone registered on that account (POST /auth/dealer/otp/request).
 * Step 2: dealer enters the OTP + new password
 *         (POST /auth/dealer/otp/reset-password).
 *
 * Proving phone possession replaces the current-password check, so this
 * screen also serves dealers who have forgotten their password. It is
 * reached from the login screen, so it does not assume a session.
 */
export default function ChangePasswordScreen({ onBack }: ChangePasswordScreenProps) {
  const insets = useSafeAreaInsets();

  const [step, setStep] = useState<"username" | "otp">("username");
  const [username, setUsername] = useState("");
  const [maskedPhone, setMaskedPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [resendIn, setResendIn] = useState(0);
  const [focused, setFocused] = useState<string | null>(null);

  // Resend countdown
  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  const errorMessage = (err: unknown, fallback: string) =>
    err instanceof ApiError ? err.message : fallback;

  const requestOtp = async () => {
    if (!username.trim() || loading) return;
    setLoading(true);
    try {
      const res = await api.post<OtpRequestResponse>(
        "/api/v1/auth/dealer/otp/request",
        { username: username.trim() }
      );
      setMaskedPhone(res.maskedPhone);
      setResendIn(res.resendAfterSeconds);
      setOtp("");
      setStep("otp");
    } catch (err) {
      // Server-side throttle tells us how long to wait; reflect it in the timer.
      if (err instanceof ApiError && err.status === 429) {
        const retry = (err.body as { retryAfterSeconds?: number } | null)
          ?.retryAfterSeconds;
        if (retry && step === "otp") setResendIn(retry);
      }
      Alert.alert("Error", errorMessage(err, "Could not send OTP. Please try again."));
    } finally {
      setLoading(false);
    }
  };

  const canSubmit =
    otp.length === 6 && !!newPassword && !!confirmPassword && !loading;

  const handleSubmit = async () => {
    if (!canSubmit) return;

    if (newPassword.length < 6) {
      Alert.alert("Weak Password", "New password must be at least 6 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      Alert.alert("Mismatch", "New password and confirmation do not match.");
      return;
    }

    setLoading(true);
    try {
      await api.post("/api/v1/auth/dealer/otp/reset-password", {
        username: username.trim(),
        otp,
        newPassword,
      });
      Alert.alert(
        "Password Changed",
        "Your password has been updated. Please log in with your new password.",
        [{ text: "OK", onPress: onBack }]
      );
    } catch (err) {
      Alert.alert("Error", errorMessage(err, "Could not change password. Please try again."));
    } finally {
      setLoading(false);
    }
  };

  const handleBack = () => {
    if (step === "otp") setStep("username");
    else onBack();
  };

  const { colors: gradColors, angle } = gradients.otpHeader;
  const { start, end } = cssAngleToPoints(angle);

  const field = (
    key: string,
    label: string,
    value: string,
    onChange: (t: string) => void,
    opts: { placeholder: string; secure?: boolean } & Pick<
      TextInputProps,
      "keyboardType" | "maxLength" | "textContentType" | "autoComplete" | "editable"
    > = { placeholder: "" }
  ) => {
    const { placeholder, secure, ...inputProps } = opts;
    return (
      <View style={styles.formGroup}>
        <Text style={styles.formLabel}>{label}</Text>
        <View style={[styles.formInput, focused === key && styles.formInputFocused]}>
          <TextInput
            style={styles.fiInput}
            value={value}
            onChangeText={onChange}
            onFocus={() => setFocused(key)}
            onBlur={() => setFocused(null)}
            placeholder={placeholder}
            placeholderTextColor={colors.ink4}
            secureTextEntry={secure}
            autoCapitalize="none"
            autoCorrect={false}
            {...inputProps}
          />
        </View>
      </View>
    );
  };

  const button = (label: string, onPress: () => void, enabled: boolean) => (
    <TouchableOpacity
      style={[styles.btnBrand, !enabled && styles.btnBrandDisabled]}
      activeOpacity={0.85}
      onPress={onPress}
      disabled={!enabled}
    >
      {loading ? (
        <ActivityIndicator color={colors.primaryForeground} />
      ) : (
        <Text style={styles.btnBrandText}>{label}</Text>
      )}
    </TouchableOpacity>
  );

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      {/* Gradient Header */}
      <LinearGradient
        colors={gradColors as unknown as [string, string]}
        start={start}
        end={end}
        style={[styles.header, { paddingTop: Math.max(insets.top + 8, 42) }]}
      >
        <TouchableOpacity onPress={handleBack} style={styles.backBtn} activeOpacity={0.7}>
          <Text style={styles.backIcon}>←</Text>
        </TouchableOpacity>

        <Text style={styles.headerTitle}>Change Password 🔒</Text>
        <Text style={styles.headerSub}>
          {step === "username"
            ? "We'll send an OTP to your registered mobile number"
            : `Enter the OTP sent to ${maskedPhone}`}
        </Text>
      </LinearGradient>

      <ScrollView
        contentContainerStyle={styles.bodyContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {field("username", "Username", username, setUsername, {
          placeholder: "Enter your username",
          editable: step === "username",
        })}

        {step === "username" ? (
          button("Send OTP", requestOtp, !!username.trim() && !loading)
        ) : (
          <>
            {field("otp", "OTP", otp, (t) => setOtp(t.replace(/\D/g, "")), {
              placeholder: "6-digit OTP",
              keyboardType: "number-pad",
              maxLength: 6,
              textContentType: "oneTimeCode",
              autoComplete: "sms-otp",
            })}

            <TouchableOpacity
              style={styles.resendContainer}
              activeOpacity={0.7}
              onPress={requestOtp}
              disabled={resendIn > 0 || loading}
            >
              <Text style={[styles.resendText, resendIn > 0 && styles.resendTextDisabled]}>
                {resendIn > 0 ? `Resend OTP in ${resendIn}s` : "Resend OTP"}
              </Text>
            </TouchableOpacity>

            {field("new", "New Password", newPassword, setNewPassword, {
              placeholder: "At least 6 characters",
              secure: true,
              textContentType: "newPassword",
            })}
            {field(
              "confirm",
              "Confirm New Password",
              confirmPassword,
              setConfirmPassword,
              { placeholder: "Re-enter new password", secure: true, textContentType: "newPassword" }
            )}

            {button("Update Password", handleSubmit, canSubmit)}
          </>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ════════════════════════════════════════════════════════════════════════
// Styles (mirrors LoginScreen for a consistent look)
// ════════════════════════════════════════════════════════════════════════
const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.card,
  },
  header: {
    paddingHorizontal: 22,
    paddingBottom: 28,
    overflow: "hidden",
    position: "relative",
  },
  backBtn: {
    width: 30,
    height: 30,
    backgroundColor: "rgba(255,255,255,0.15)",
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 14,
  },
  backIcon: {
    fontSize: 15,
    color: colors.primaryForeground,
    lineHeight: 17,
  },
  headerTitle: {
    fontFamily: fonts.headingExtra,
    fontSize: 16,
    color: colors.primaryForeground,
    lineHeight: 20.8,
  },
  headerSub: {
    fontSize: 11,
    fontFamily: fonts.medium,
    color: "rgba(255,255,255,0.65)",
    marginTop: 5,
    lineHeight: 16.5,
  },
  bodyContent: {
    padding: 20,
    paddingBottom: 40,
  },
  formGroup: {
    marginBottom: 16,
  },
  formLabel: {
    fontSize: 9,
    fontFamily: fonts.extrabold,
    color: colors.mutedForeground,
    textTransform: "uppercase",
    letterSpacing: 1,
    marginBottom: 5,
  },
  formInput: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.background,
    borderWidth: 2,
    borderColor: colors.border,
    borderRadius: 11,
    paddingVertical: 11,
    paddingHorizontal: 12,
  },
  formInputFocused: {
    borderColor: colors.primary,
    backgroundColor: colors.primaryLight,
  },
  fiInput: {
    flex: 1,
    fontSize: 13,
    fontFamily: fonts.semibold,
    color: colors.foreground,
    padding: 0,
  },
  btnBrand: {
    width: "100%",
    backgroundColor: colors.primary,
    borderRadius: 14,
    paddingVertical: 13,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 48,
    marginTop: 8,
  },
  btnBrandDisabled: {
    opacity: 0.5,
  },
  btnBrandText: {
    fontSize: 14,
    fontFamily: fonts.extrabold,
    color: colors.primaryForeground,
  },
  resendContainer: {
    alignSelf: "flex-end",
    marginTop: -8,
    marginBottom: 16,
    paddingVertical: 4,
  },
  resendText: {
    fontSize: 12,
    fontFamily: fonts.bold,
    color: colors.primary,
  },
  resendTextDisabled: {
    color: colors.mutedForeground,
  },
});
