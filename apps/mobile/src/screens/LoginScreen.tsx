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
import { useAuthStore } from "../store/auth";
import { ApiError } from "../lib/api";

interface LoginScreenProps {
  onSuccess: () => void;
  onBack: () => void;
}

export default function LoginScreen({ onSuccess, onBack }: LoginScreenProps) {
  const insets = useSafeAreaInsets();
  const login = useAuthStore((s) => s.login);   // ← Make sure your auth store has this method

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [usernameFocused, setUsernameFocused] = useState(false);
  const [passwordFocused, setPasswordFocused] = useState(false);

  const handleLogin = async () => {
    if (!username || !password || loading) return;

    setLoading(true);
    try {
      const success = await login(username, password);
      if (success) {
        onSuccess();
      } else {
        Alert.alert("Login Failed", "Invalid username or password.");
      }
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Login failed. Please try again.";
      Alert.alert("Error", msg);
    } finally {
      setLoading(false);
    }
  };

  const { colors: gradColors, angle } = gradients.otpHeader;
  const { start, end } = cssAngleToPoints(angle);

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

        <Text style={styles.headerTitle}>Dealer Login 👋</Text>
        <Text style={styles.headerSub}>
          Sign in with your username and password
        </Text>
      </LinearGradient>

      <ScrollView
        contentContainerStyle={styles.bodyContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* Username */}
        <View style={styles.formGroup}>
          <Text style={styles.formLabel}>Username / Phone</Text>
          <View style={[styles.formInput, usernameFocused && styles.formInputFocused]}>
            <TextInput
              style={styles.fiInput}
              value={username}
              onChangeText={setUsername}
              onFocus={() => setUsernameFocused(true)}
              onBlur={() => setUsernameFocused(false)}
              placeholder="Enter username or phone"
              placeholderTextColor={colors.ink4}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>
        </View>

        {/* Password */}
        <View style={styles.formGroup}>
          <Text style={styles.formLabel}>Password</Text>
          <View style={[styles.formInput, passwordFocused && styles.formInputFocused]}>
            <TextInput
              style={styles.fiInput}
              value={password}
              onChangeText={setPassword}
              onFocus={() => setPasswordFocused(true)}
              onBlur={() => setPasswordFocused(false)}
              placeholder="Enter password"
              placeholderTextColor={colors.ink4}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>
        </View>

        {/* Login Button */}
        <TouchableOpacity
          style={[styles.btnBrand, (!username || !password || loading) && styles.btnBrandDisabled]}
          activeOpacity={0.85}
          onPress={handleLogin}
          disabled={!username || !password || loading}
        >
          {loading ? (
            <ActivityIndicator color={colors.primaryForeground} />
          ) : (
            <Text style={styles.btnBrandText}>Login</Text>
          )}
        </TouchableOpacity>

        {/* Optional: Forgot Password */}
        <TouchableOpacity style={styles.forgotContainer}>
          <Text style={styles.forgotText}>Forgot Password?</Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ════════════════════════════════════════════════════════════════════════
// Styles (kept consistent with your original design)
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

  forgotContainer: {
    alignItems: "center",
    marginTop: 20,
  },
  forgotText: {
    fontSize: 11,
    fontFamily: fonts.medium,
    color: colors.primary,
  },
});