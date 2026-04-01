import React from "react";
import { View, Text, TouchableOpacity, StyleSheet, StatusBar } from "react-native";
import { colors } from "../lib/theme";

interface Props {
  onLogin: () => void;
}

export default function SplashScreen({ onLogin }: Props) {
  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" />

      <View style={styles.header}>
        <Text style={styles.logo}>🐄</Text>
        <Text style={styles.orgName}>
          Haveri District Co-operative{"\n"}Milk Producers' Union
        </Text>
        <Text style={styles.est}>Est. 1984</Text>
      </View>

      <View style={styles.hero}>
        <Text style={styles.truck}>🚚</Text>
        <Text style={styles.headline}>
          Order fresh dairy.{"\n"}
          <Text style={styles.headlineItalic}>Every morning.</Text>
        </Text>
        <Text style={styles.tagline}>
          Digital indent system for{"\n"}registered dealer agencies
        </Text>
      </View>

      <View style={styles.bottom}>
        <TouchableOpacity style={styles.loginBtn} onPress={onLogin} activeOpacity={0.8}>
          <Text style={styles.loginBtnText}>Login as Dealer →</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.registerBtn} activeOpacity={0.8}>
          <Text style={styles.registerBtnText}>New Agency Registration</Text>
        </TouchableOpacity>

        <View style={styles.langRow}>
          <View style={[styles.langBtn, styles.langActive]}>
            <Text style={[styles.langText, styles.langActiveText]}>English</Text>
          </View>
          <View style={styles.langBtn}>
            <Text style={styles.langText}>ಕನ್ನಡ</Text>
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 24, backgroundColor: "#1448CC" },
  header: { alignItems: "center", paddingTop: 60 },
  logo: { fontSize: 48, marginBottom: 8 },
  orgName: { fontSize: 11, fontWeight: "700", color: "rgba(255,255,255,0.9)", textAlign: "center", lineHeight: 16 },
  est: { fontSize: 10, color: "rgba(255,255,255,0.5)", marginTop: 4, fontWeight: "600" },
  hero: { flex: 1, justifyContent: "center", alignItems: "center" },
  truck: { fontSize: 56, marginBottom: 16 },
  headline: { fontSize: 26, fontWeight: "800", color: "#fff", textAlign: "center", lineHeight: 34 },
  headlineItalic: { fontStyle: "italic" },
  tagline: { fontSize: 13, color: "rgba(255,255,255,0.7)", textAlign: "center", marginTop: 12, lineHeight: 20, fontWeight: "500" },
  bottom: { paddingBottom: 40 },
  loginBtn: { backgroundColor: "#fff", borderRadius: 14, height: 52, alignItems: "center", justifyContent: "center", marginBottom: 12 },
  loginBtnText: { fontSize: 15, fontWeight: "800", color: colors.brand },
  registerBtn: { borderWidth: 1.5, borderColor: "rgba(255,255,255,0.3)", borderRadius: 14, height: 48, alignItems: "center", justifyContent: "center", marginBottom: 20 },
  registerBtnText: { fontSize: 13, fontWeight: "700", color: "rgba(255,255,255,0.8)" },
  langRow: { flexDirection: "row", justifyContent: "center", gap: 8 },
  langBtn: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20, backgroundColor: "rgba(255,255,255,0.1)" },
  langActive: { backgroundColor: "rgba(255,255,255,0.2)" },
  langText: { fontSize: 12, fontWeight: "700", color: "rgba(255,255,255,0.6)" },
  langActiveText: { color: "#fff" },
});