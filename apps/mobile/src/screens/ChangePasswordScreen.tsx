import React, { useState } from "react";
import {
  ActivityIndicator,
  Alert,
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
} from "../lib/theme";
import { api, ApiError } from "../lib/api";

interface ChangePasswordScreenProps {
  /** Called after a successful change (and on the back arrow). */
  onBack: () => void;
}

/**
 * ChangePasswordScreen — replaces the old "Forgot Password" flow.
 *
 * The dealer proves they know their current password (no OTP / SMS), so the
 * screen collects username + current password + new password and calls
 * POST /api/v1/auth/dealer/change-password. It is reached from the login
 * screen, so it does not assume an authenticated session.
 */
export default function ChangePasswordScreen({ onBack }: ChangePasswordScreenProps) {
  const insets = useSafeAreaInsets();

  const [username, setUsername] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [focused, setFocused] = useState<string | null>(null);

  const canSubmit =
    !!username &&
    !!currentPassword &&
    !!newPassword &&
    !!confirmPassword &&
    !loading;

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
    if (newPassword === currentPassword) {
      Alert.alert(
        "Same Password",
        "New password must be different from your current password."
      );
      return;
    }

    setLoading(true);
    try {
      await api.post("/api/v1/auth/dealer/change-password", {
        username,
        currentPassword,
        newPassword,
      });
      Alert.alert(
        "Password Changed",
        "Your password has been updated. Please log in with your new password.",
        [{ text: "OK", onPress: onBack }]
      );
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.message
          : "Could not change password. Please try again.";
      Alert.alert("Error", msg);
    } finally {
      setLoading(false);
    }
  };

  const { colors: gradColors, angle } = gradients.otpHeader;
  const { start, end } = cssAngleToPoints(angle);

  const field = (
    key: string,
    label: string,
    value: string,
    onChange: (t: string) => void,
    opts: { placeholder: string; secure?: boolean } = { placeholder: "" }
  ) => (
    <View style={styles.formGroup}>
      <Text style={styles.formLabel}>{label}</Text>
      <View style={[styles.formInput, focused === key && styles.formInputFocused]}>
        <TextInput
          style={styles.fiInput}
          value={value}
          onChangeText={onChange}
          onFocus={() => setFocused(key)}
          onBlur={() => setFocused(null)}
          placeholder={opts.placeholder}
          placeholderTextColor={colors.ink4}
          secureTextEntry={opts.secure}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>
    </View>
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
        <TouchableOpacity onPress={onBack} style={styles.backBtn} activeOpacity={0.7}>
          <Text style={styles.backIcon}>←</Text>
        </TouchableOpacity>

        <Text style={styles.headerTitle}>Change Password 🔒</Text>
        <Text style={styles.headerSub}>
          Verify your current password to set a new one
        </Text>
      </LinearGradient>

      <ScrollView
        contentContainerStyle={styles.bodyContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {field("username", "Username / Phone", username, setUsername, {
          placeholder: "Enter username or phone",
        })}
        {field(
          "current",
          "Current Password",
          currentPassword,
          setCurrentPassword,
          { placeholder: "Enter current password", secure: true }
        )}
        {field("new", "New Password", newPassword, setNewPassword, {
          placeholder: "At least 6 characters",
          secure: true,
        })}
        {field(
          "confirm",
          "Confirm New Password",
          confirmPassword,
          setConfirmPassword,
          { placeholder: "Re-enter new password", secure: true }
        )}

        <TouchableOpacity
          style={[styles.btnBrand, !canSubmit && styles.btnBrandDisabled]}
          activeOpacity={0.85}
          onPress={handleSubmit}
          disabled={!canSubmit}
        >
          {loading ? (
            <ActivityIndicator color={colors.primaryForeground} />
          ) : (
            <Text style={styles.btnBrandText}>Update Password</Text>
          )}
        </TouchableOpacity>
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
});
