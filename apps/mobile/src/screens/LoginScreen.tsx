import React, { useState, useRef } from "react";
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  Alert, ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView,
} from "react-native";
import { colors } from "../lib/theme";
import { useAuthStore } from "../store/auth";

interface Props {
  onSuccess: () => void;
  onBack: () => void;
}

export default function LoginScreen({ onSuccess, onBack }: Props) {
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState(["", "", "", "", "", ""]);
  const [otpSent, setOtpSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const otpRefs = useRef<(TextInput | null)[]>([]);
  const { requestOtp, verifyOtp } = useAuthStore();

  const showError = (msg: string) => {
    setError(msg);
    if (Platform.OS !== "web") {
      Alert.alert("Error", msg);
    }
  };

  const handleSendOtp = async () => {
    if (phone.length < 10) return showError("Enter a valid 10-digit number");
    setLoading(true);
    setError("");
    try {
      await requestOtp(phone);
      setOtpSent(true);
    } catch (err: any) {
      showError(err?.data?.message || "Failed to send OTP. Check your connection.");
    } finally {
      setLoading(false);
    }
  };

  const handleOtpChange = (text: string, index: number) => {
    const newOtp = [...otp];
    newOtp[index] = text.slice(-1); // Only last character
    setOtp(newOtp);

    if (text && index < 5) {
      otpRefs.current[index + 1]?.focus();
    }
  };

  const handleOtpKeyPress = (e: any, index: number) => {
    if (e.nativeEvent.key === "Backspace" && !otp[index] && index > 0) {
      otpRefs.current[index - 1]?.focus();
    }
  };

  const handleVerify = async () => {
    const code = otp.join("");
    if (code.length !== 6) return showError("Enter the complete 6-digit OTP");
    setLoading(true);
    setError("");
    try {
      const success = await verifyOtp(phone, code);
      if (success) {
        // Explicitly navigate — don't rely solely on state subscription
        onSuccess();
      }
    } catch (err: any) {
      showError(err?.data?.message || "Invalid OTP. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={onBack} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Text style={styles.back}>←</Text>
          </TouchableOpacity>
          <Text style={styles.title}>Dealer Login 👋</Text>
          <Text style={styles.subtitle}>
            Enter your mobile number linked to your agency account
          </Text>
        </View>

        {/* Error banner */}
        {error ? (
          <View style={styles.errorBanner}>
            <Text style={styles.errorText}>⚠️ {error}</Text>
          </View>
        ) : null}

        {/* Phone input */}
        <Text style={styles.label}>Mobile Number</Text>
        <View style={styles.inputRow}>
          <Text style={styles.flag}>🇮🇳</Text>
          <Text style={styles.prefix}>+91</Text>
          <View style={styles.divider} />
          <TextInput
            style={styles.phoneInput}
            value={phone}
            onChangeText={(t) => setPhone(t.replace(/[^0-9]/g, ""))}
            placeholder="98765 43210"
            placeholderTextColor={colors.mutedFg}
            keyboardType="phone-pad"
            maxLength={10}
            editable={!otpSent}
          />
        </View>

        {/* Send OTP */}
        {!otpSent && (
          <TouchableOpacity
            style={[styles.brandBtn, loading && styles.brandBtnDisabled]}
            onPress={handleSendOtp}
            disabled={loading}
            activeOpacity={0.8}
          >
            {loading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.brandBtnText}>Send OTP →</Text>
            )}
          </TouchableOpacity>
        )}

        {/* OTP input */}
        {otpSent && (
          <>
            <Text style={[styles.label, { marginTop: 24 }]}>Enter 6-Digit OTP</Text>
            <View style={styles.otpRow}>
              {otp.map((digit, i) => (
                <TextInput
                  key={i}
                  ref={(ref) => { otpRefs.current[i] = ref; }}
                  style={[styles.otpBox, digit ? styles.otpBoxFilled : null]}
                  value={digit}
                  onChangeText={(t) => handleOtpChange(t, i)}
                  onKeyPress={(e) => handleOtpKeyPress(e, i)}
                  keyboardType="number-pad"
                  maxLength={1}
                  selectTextOnFocus
                  autoFocus={i === 0}
                />
              ))}
            </View>

            <TouchableOpacity
              style={[styles.brandBtn, loading && styles.brandBtnDisabled]}
              onPress={handleVerify}
              disabled={loading}
              activeOpacity={0.8}
            >
              {loading ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.brandBtnText}>Verify & Login</Text>
              )}
            </TouchableOpacity>

            <TouchableOpacity onPress={() => { setOtpSent(false); setOtp(["","","","","",""]); }} style={styles.resendBtn}>
              <Text style={styles.resend}>← Change number or resend OTP</Text>
            </TouchableOpacity>
          </>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  scroll: { paddingHorizontal: 20, paddingBottom: 40 },
  header: { paddingTop: 56, marginBottom: 28 },
  back: { fontSize: 24, color: colors.fg, marginBottom: 20 },
  title: { fontSize: 24, fontWeight: "800", color: colors.fg, marginBottom: 8 },
  subtitle: { fontSize: 14, color: colors.mutedFg, fontWeight: "500", lineHeight: 21 },
  errorBanner: { backgroundColor: colors.dangerLight, borderRadius: 10, padding: 12, marginBottom: 16 },
  errorText: { fontSize: 12, color: colors.danger, fontWeight: "600" },
  label: { fontSize: 13, fontWeight: "700", color: colors.fg, marginBottom: 8 },
  inputRow: { flexDirection: "row", alignItems: "center", height: 54, borderWidth: 1.5, borderColor: colors.border, borderRadius: 14, paddingHorizontal: 14, marginBottom: 20 },
  flag: { fontSize: 18, marginRight: 6 },
  prefix: { fontSize: 15, fontWeight: "700", color: colors.fg },
  divider: { width: 1, height: 24, backgroundColor: colors.border, marginHorizontal: 12 },
  phoneInput: { flex: 1, fontSize: 17, fontWeight: "700", color: colors.fg, letterSpacing: 1 },
  brandBtn: { backgroundColor: colors.brand, height: 54, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  brandBtnDisabled: { opacity: 0.7 },
  brandBtnText: { fontSize: 16, fontWeight: "800", color: "#fff" },
  otpRow: { flexDirection: "row", gap: 8, marginBottom: 24, justifyContent: "center" },
  otpBox: { width: 48, height: 58, borderWidth: 2, borderColor: colors.border, borderRadius: 12, textAlign: "center", fontSize: 24, fontWeight: "800", color: colors.fg, backgroundColor: "#fff" },
  otpBoxFilled: { borderColor: colors.brand, backgroundColor: colors.brandLight },
  resendBtn: { marginTop: 20, alignItems: "center" },
  resend: { fontSize: 13, color: colors.brand, fontWeight: "600" },
});
