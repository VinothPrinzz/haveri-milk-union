import React, { useMemo, useState } from "react";
import {
  Alert,
  Linking,
  ScrollView,
  StyleSheet,
  Switch,
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
  shadows,
} from "../lib/theme";
import { useAuthStore } from "../store/auth";
import { useMyOrders } from "../hooks/useOrders";
import { useMyInvoices } from "../hooks/useInvoices";

type Lang = "en" | "kn";

export default function ProfileScreen() {
  const insets = useSafeAreaInsets();
  const dealer = useAuthStore((s) => s.dealer);
  const patchDealer = useAuthStore((s) => s.patchDealer);
  const logout = useAuthStore((s) => s.logout);
  const ordersQuery = useMyOrders({ page: 1, limit: 50 });
  const invQuery = useMyInvoices();
  const [lang, setLang] = useState<Lang>(dealer?.languagePref ?? "en");
  const [notifEnabled, setNotifEnabled] = useState(
    dealer?.notificationsEnabled ?? false
  );
  const [bioEnabled, setBioEnabled] = useState(
    dealer?.biometricEnabled ?? false
  );

  const stats = useMemo(() => {
    const orders = ordersQuery.data?.data ?? [];
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const thisMonth = orders.filter(
      (o) => new Date(o.createdAt).getTime() >= monthStart && o.status !== "cancelled"
    );
    const monthValue = invQuery.data?.summary.totalOrders
      ?? thisMonth.reduce((a, o) => a + o.grandTotal, 0);
    let memberLabel = "—";
    if (dealer?.memberSince) {
      const since = new Date(dealer.memberSince);
      if (!Number.isNaN(since.getTime())) {
        const diffYears = Math.floor(
          (now.getTime() - since.getTime()) / (365.25 * 86_400_000)
        );
        if (diffYears >= 1) memberLabel = `${diffYears}yr`;
        else {
          const months = Math.max(
            0,
            (now.getFullYear() - since.getFullYear()) * 12 +
              (now.getMonth() - since.getMonth())
          );
          memberLabel = `${months}mo`;
        }
      }
    }
    const monthAbbr = now.toLocaleDateString("en-US", { month: "short" });
    return {
      monthOrders: thisMonth.length,
      monthOrdersLabel: `Orders ${monthAbbr}`,
      monthValue: formatLakhsShort(monthValue),
      monthValueLabel: `${monthAbbr} Value`,
      memberLabel,
    };
  }, [ordersQuery.data, invQuery.data, dealer?.memberSince]);

  const handleLangChange = (l: Lang) => {
    setLang(l);
    patchDealer({ languagePref: l });
  };
  const handleNotifToggle = (v: boolean) => {
    setNotifEnabled(v);
    patchDealer({ notificationsEnabled: v });
  };
  const handleBioToggle = (v: boolean) => {
    setBioEnabled(v);
    patchDealer({ biometricEnabled: v });
  };
  const handleContact = () => {
    Alert.alert(
      "Contact Haveri Milk Union",
      "Choose how you'd like to reach us:",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Call", onPress: () => Linking.openURL("tel:+918375000000") },
        {
          text: "WhatsApp",
          onPress: () =>
            Linking.openURL("https://wa.me/918375000000").catch(() => {}),
        },
      ]
    );
  };
  const handleHelp = () => {
    Alert.alert("Help & FAQs", "FAQ section coming soon.");
  };
  const handleAppInfo = () => {
    Alert.alert(
      "App Information",
      "HMU Dealer App v2.1.4\n\nLicensed to Haveri District Co-operative Milk Producers' Union",
      [{ text: "OK" }]
    );
  };
  const handleEditField = (field: string) => {
    Alert.alert(
      "Edit Profile",
      `Editing ${field} requires admin approval. Please contact your union office.`
    );
  };
  const handleLogout = () => {
    Alert.alert(
      "Logout?",
      `You'll be logged out from ${dealer?.name ?? "your account"}.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Logout",
          style: "destructive",
          onPress: async () => {
            await logout();
          },
        },
      ]
    );
  };

  if (!dealer) return null;

  const { colors: gradColors, angle } = gradients.profileHeader;
  const { start, end } = cssAngleToPoints(angle);

  return (
    <View style={styles.root}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <LinearGradient
          colors={gradColors as unknown as [string, string]}
          start={start}
          end={end}
          style={[
            styles.header,
            { paddingTop: Math.max(insets.top + 8, 42) },
          ]}
        >
          <View style={styles.agencyCard}>
            <View style={styles.agencyAvatar}>
              <Text style={styles.agencyAvatarText}>🏪</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.agencyName} numberOfLines={1}>
                {dealer.name}
              </Text>
              <Text style={styles.agencyId} numberOfLines={1}>
                ID: {dealer.code ?? "—"} · {dealer.zoneName ?? dealer.locationLabel ?? ""}
              </Text>
              {dealer.verified && (
                <View style={styles.verifiedBadge}>
                  <Text style={styles.verifiedText}>✓ Verified Dealer</Text>
                </View>
              )}
            </View>
          </View>

          {/* Updated Stats Strip - Credit Limit replaces "Member" */}
          <View style={styles.statsStrip}>
            <StatCell value={String(stats.monthOrders)} label={stats.monthOrdersLabel} />
            <View style={styles.statDivider} />
            <StatCell value={stats.monthValue} label={stats.monthValueLabel} />
            <View style={styles.statDivider} />
            <StatCell
              value={
                dealer.creditLimit && dealer.creditLimit > 0
                  ? `Rs ${formatCompact(dealer.creditLimit)}`
                  : "—"
              }
              label="Credit Limit"
            />
          </View>
        </LinearGradient>

        {/* Body groups */}
        <View style={styles.body}>
          {/* Group 1: Account info */}
          <View style={styles.group}>
            <ProfileItem
              icon="📍"
              tint="blue"
              title="Delivery Zone"
              sub={`${dealer.zoneName ?? "—"}${dealer.locationLabel ? ` · ${dealer.locationLabel}` : ""}`}
              onPress={() => handleEditField("delivery zone")}
              showArrow
            />
            <ProfileItem
              icon="📱"
              tint="blue"
              title="Mobile Number"
              sub={`+91 ${formatPhone(dealer.phone)}${dealer.verified ? " · Verified" : ""}`}
              onPress={() => handleEditField("mobile number")}
              showArrow
            />
            <ProfileItem
              icon="💳"
              tint="green"
              title="Credit Limit"
              sub={
                dealer.creditLimit > 0
                  ? `₹${dealer.creditLimit.toLocaleString("en-IN")}` +
                    (dealer.creditOutstanding
                      ? ` · ₹${(dealer.creditLimit - dealer.creditOutstanding).toLocaleString("en-IN")} available`
                      : "")
                  : "Not set"
              }
              showArrow={false}
            />
            <ProfileItem
              icon="🏢"
              tint="amber"
              title="GST Number"
              sub={dealer.gstNumber ?? "Not registered"}
              onPress={() => handleEditField("GST number")}
              showArrow
              isLast
            />
          </View>

          {/* Group 2: Preferences */}
          <View style={styles.group}>
            <ProfileItem
              icon="🌐"
              tint="gray"
              title="Language"
              sub="App display language"
              right={<LangSwitch value={lang} onChange={handleLangChange} />}
            />
            <ProfileItem
              icon="🔔"
              tint="blue"
              title="Morning Reminder"
              sub="Alert at 5:55 AM"
              right={
                <Switch
                  value={notifEnabled}
                  onValueChange={handleNotifToggle}
                  trackColor={{ false: colors.ink5, true: colors.success }}
                  thumbColor={colors.card}
                  ios_backgroundColor={colors.ink5}
                />
              }
            />
            <ProfileItem
              icon="🔐"
              tint="blue"
              title="Biometric Login"
              sub="Fingerprint / Face ID"
              right={
                <Switch
                  value={bioEnabled}
                  onValueChange={handleBioToggle}
                  trackColor={{ false: colors.ink5, true: colors.success }}
                  thumbColor={colors.card}
                  ios_backgroundColor={colors.ink5}
                />
              }
              isLast
            />
          </View>

          {/* Group 3: Support */}
          <View style={styles.group}>
            <ProfileItem
              icon="❓"
              tint="green"
              title="Help & FAQs"
              sub="Common questions"
              onPress={handleHelp}
              showArrow
            />
            <ProfileItem
              icon="📞"
              tint="green"
              title="Contact Union"
              sub="Call or WhatsApp support"
              onPress={handleContact}
              showArrow
            />
            <ProfileItem
              icon="ℹ️"
              tint="gray"
              title="App Version 2.1.4"
              sub="Terms · Privacy Policy"
              onPress={handleAppInfo}
              showArrow
              isLast
            />
          </View>

          {/* Logout row */}
          <TouchableOpacity
            onPress={handleLogout}
            activeOpacity={0.85}
            style={styles.logoutRow}
            accessibilityRole="button"
          >
            <Text style={styles.logoutEmoji}>🚪</Text>
            <Text style={styles.logoutText}>
              Logout from {dealer.name}
            </Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </View>
  );
}

// ════════════════════════════════════════════════════════════════════════
// Sub-components
// ════════════════════════════════════════════════════════════════════════
function StatCell({ value, label }: { value: string; label: string }) {
  return (
    <View style={statStyles.cell}>
      <Text style={statStyles.value} numberOfLines={1}>{value}</Text>
      <Text style={statStyles.label}>{label}</Text>
    </View>
  );
}

interface ProfileItemProps {
  icon: string;
  tint: "blue" | "green" | "amber" | "gray";
  title: string;
  sub: string;
  onPress?: () => void;
  right?: React.ReactNode;
  showArrow?: boolean;
  isLast?: boolean;
}

function ProfileItem({
  icon,
  tint,
  title,
  sub,
  onPress,
  right,
  showArrow,
  isLast,
}: ProfileItemProps) {
  const Wrapper: React.ComponentType<any> = onPress ? TouchableOpacity : View;
  const wrapperProps = onPress
    ? { activeOpacity: 0.7, onPress, accessibilityRole: "button" as const }
    : {};
  return (
    <Wrapper
      style={[itemStyles.row, isLast && itemStyles.rowLast]}
      {...wrapperProps}
    >
      <View style={[itemStyles.iconWrap, ICON_TINT[tint]]}>
        <Text style={itemStyles.iconText}>{icon}</Text>
      </View>
      <View style={itemStyles.text}>
        <Text style={itemStyles.title} numberOfLines={1}>{title}</Text>
        <Text style={itemStyles.sub} numberOfLines={1}>{sub}</Text>
      </View>
      {right ? right : showArrow ? <Text style={itemStyles.arrow}>›</Text> : null}
    </Wrapper>
  );
}

function LangSwitch({
  value,
  onChange,
}: {
  value: Lang;
  onChange: (l: Lang) => void;
}) {
  return (
    <View style={langStyles.wrap}>
      <TouchableOpacity
        onPress={() => onChange("en")}
        activeOpacity={0.7}
        style={[langStyles.opt, value === "en" && langStyles.optActive]}
      >
        <Text style={[langStyles.text, value === "en" && langStyles.textActive]}>
          EN
        </Text>
      </TouchableOpacity>
      <TouchableOpacity
        onPress={() => onChange("kn")}
        activeOpacity={0.7}
        style={[langStyles.opt, value === "kn" && langStyles.optActive]}
      >
        <Text style={[langStyles.text, value === "kn" && langStyles.textActive]}>
          ಕನ್ನ
        </Text>
      </TouchableOpacity>
    </View>
  );
}

// ════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════
function formatPhone(phone: string): string {
  if (phone.length === 10) {
    return `${phone.slice(0, 5)} ${phone.slice(5)}`;
  }
  return phone;
}

/** Format big rupee amount: 124800 → "₹1.2L", 1500 → "₹1.5K", 850 → "₹850" */
function formatLakhsShort(amount: number): string {
  if (!amount || Number.isNaN(amount)) return "₹0";
  const abs = Math.abs(amount);
  if (abs >= 10_00_000) return `₹${(amount / 10_00_000).toFixed(1)}Cr`;
  if (abs >= 1_00_000) return `₹${(amount / 1_00_000).toFixed(1)}L`;
  if (abs >= 1_000) return `₹${(amount / 1_000).toFixed(1)}K`;
  return `₹${Math.round(amount)}`;
}

// ←←← NEW HELPER ADDED AS INSTRUCTED
function formatCompact(n: number): string {
  if (n >= 100_000) return (n / 100_000).toFixed(n % 100_000 === 0 ? 0 : 1) + "L";
  if (n >= 1_000)   return (n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1) + "k";
  return String(n);
}

// ════════════════════════════════════════════════════════════════════════
// Styles (unchanged)
// ════════════════════════════════════════════════════════════════════════
const ICON_TINT = {
  blue: { backgroundColor: colors.primaryLight },
  green: { backgroundColor: colors.successLight },
  amber: { backgroundColor: colors.warningLight },
  gray: { backgroundColor: colors.background },
};

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
  },
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: 24 },
  // Header
  header: {
    paddingHorizontal: 16,
    paddingBottom: 22,
  },
  agencyCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  agencyAvatar: {
    width: 52,
    height: 52,
    backgroundColor: "rgba(255,255,255,0.15)",
    borderRadius: 18,
    borderWidth: 2,
    borderColor: "rgba(255,255,255,0.2)",
    alignItems: "center",
    justifyContent: "center",
  },
  agencyAvatarText: {
    fontSize: 26,
  },
  agencyName: {
    fontFamily: fonts.headingExtra,
    fontSize: 14,
    color: colors.primaryForeground,
  },
  agencyId: {
    fontSize: 9,
    fontFamily: fonts.semibold,
    color: "rgba(255,255,255,0.6)",
    marginTop: 2,
  },
  verifiedBadge: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(74,222,128,0.2)",
    borderWidth: 1,
    borderColor: "rgba(74,222,128,0.3)",
    borderRadius: 999,
    paddingVertical: 3,
    paddingHorizontal: 9,
    marginTop: 5,
  },
  verifiedText: {
    fontSize: 9,
    fontFamily: fonts.bold,
    color: colors.dotGreen,
  },
  statsStrip: {
    flexDirection: "row",
    marginTop: 16,
    backgroundColor: colors.white10,
    borderRadius: 14,
    overflow: "hidden",
  },
  statDivider: {
    width: 1,
    backgroundColor: colors.white10,
  },
  // Body
  body: {
    padding: 12,
  },
  group: {
    backgroundColor: colors.card,
    borderRadius: 14,
    overflow: "hidden",
    marginBottom: 9,
    ...shadows.sm,
  },
  // Logout
  logoutRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    backgroundColor: colors.destructiveLight,
    borderRadius: 14,
    padding: 12,
    marginBottom: 9,
    minHeight: 44,
  },
  logoutEmoji: {
    fontSize: 17,
  },
  logoutText: {
    fontSize: 12,
    fontFamily: fonts.extrabold,
    color: colors.destructive,
  },
});

const statStyles = StyleSheet.create({
  cell: {
    flex: 1,
    paddingVertical: 11,
    paddingHorizontal: 7,
    alignItems: "center",
  },
  value: {
    fontFamily: fonts.headingBlack,
    fontSize: 13,
    color: colors.primaryForeground,
  },
  label: {
    fontSize: 8,
    fontFamily: fonts.semibold,
    color: "rgba(255,255,255,0.5)",
    marginTop: 2,
    textTransform: "uppercase",
    letterSpacing: 0.3,
  },
});

const itemStyles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    minHeight: 44,
  },
  rowLast: {
    borderBottomWidth: 0,
  },
  iconWrap: {
    width: 32,
    height: 32,
    borderRadius: 7,
    alignItems: "center",
    justifyContent: "center",
  },
  iconText: {
    fontSize: 15,
  },
  text: {
    flex: 1,
  },
  title: {
    fontSize: 11,
    fontFamily: fonts.bold,
    color: colors.foreground,
  },
  sub: {
    fontSize: 9,
    fontFamily: fonts.medium,
    color: colors.mutedForeground,
    marginTop: 1,
  },
  arrow: {
    fontSize: 13,
    color: colors.ink5,
    fontFamily: fonts.bold,
  },
});

const langStyles = StyleSheet.create({
  wrap: {
    flexDirection: "row",
    gap: 5,
  },
  opt: {
    paddingVertical: 3,
    paddingHorizontal: 9,
    borderRadius: 7,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
  },
  optActive: {
    backgroundColor: colors.primaryLight,
    borderColor: colors.primaryLight2,
  },
  text: {
    fontSize: 10,
    fontFamily: fonts.bold,
    color: colors.mutedForeground,
  },
  textActive: {
    color: colors.primary,
  },
});