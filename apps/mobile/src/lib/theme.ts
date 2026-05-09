/**
 * HMU Dealer App — Design Tokens
 *
 * Source of truth:
 *   - /dealer-app-summary.md §3 (Design System)
 *   - /dealer-app.html :root CSS vars (authoritative for exact hex values)
 *
 * React Native has no CSS variables, so these are flat JS constants.
 * Every HSL token from the summary has been converted to hex and cross-
 * referenced with the mockup's `--brand` / `--amber` etc.
 */

export const colors = {
  // Surfaces
  background: "#EEF2FA",         // spec: hsl(225 33% 95%) · mockup --bg
  foreground: "#0D1B2A",         // spec: hsl(214 50% 10%) · mockup --ink
  card: "#FFFFFF",
  cardForeground: "#0D1B2A",

  // Primary (brand blue)
  primary: "#1448CC",            // spec: hsl(222 82% 44%) · mockup --brand
  primaryForeground: "#FFFFFF",
  primaryDark: "#0D33A0",        // spec: hsl(225 84% 34%) · mockup --brand-d
  primaryLight: "#EBF0FF",       // spec: hsl(225 100% 95%) · mockup --brand-l
  primaryLight2: "#D6E2FF",      // spec: hsl(225 100% 90%) · mockup --brand-l2

  // Secondary (warm yellow family)
  secondary: "#FFD633",          // spec: hsl(45 100% 60%)
  secondaryForeground: "#3A2914",
  yellowAccent: "#FCD34D",       // splash hero "em" color · "HURRY!" tile · active-order invoice pill
  yellowAccent2: "#FCA5A5",      // closed-state "hrs away" tile

  // Muted
  muted: "#F3F4F7",              // spec: hsl(220 14% 96%)
  mutedForeground: "#6B7280",    // spec: hsl(220 9% 46%) · mockup --ink3

  // Accent (soft blue tint — bigger than primaryLight)
  accent: "#EAEFFD",             // spec: hsl(225 80% 95%)
  accentForeground: "#1448CC",

  // Semantic
  destructive: "#DC2626",        // spec: hsl(0 72% 51%) · mockup --red
  destructiveLight: "#FEE2E2",   // mockup --red-l
  success: "#16A34A",            // spec: hsl(142 71% 45%) · mockup --green
  successLight: "#DCFCE7",       // spec: hsl(138 76% 93%) · mockup --green-l
  successBorder: "#BBF7D0",      // biometric hint card border (spec §5.1)
  warning: "#D97706",            // mockup --amber (authoritative over summary's #F59E0B)
  warningLight: "#FEF3C7",       // spec: hsl(48 96% 89%) · mockup --amber-l
  warningBorder: "#FDE68A",      // ClosingSoonBanner border (spec §6.10)
  info: "#0891B2",               // spec: hsl(193 82% 37%) · mockup --teal
  infoLight: "#E0F7FA",          // spec: hsl(186 100% 94%) · mockup --teal-l

  // Text grays (mockup --ink2, --ink4, --ink5)
  ink2: "#374151",
  ink4: "#9CA3AF",
  ink5: "#D1D5DB",

  // Borders + inputs
  border: "#E5E7EB",             // spec: hsl(220 13% 91%)
  input: "#E5E7EB",
  ring: "#1448CC",

  // Status dots (inline on banners, nav badges)
  dotGreen: "#4ADE80",           // open-window pulse
  dotAmber: "#FBBF24",           // closing-soon pulse
  dotRed: "#EF4444",             // closed / notification-unread

  // Window-state solid fills (for gradients see `gradients` below)
  windowOpenSolid: "#1448CC",
  windowWarningSolid: "#92400E",
  windowClosedSolid: "#111827",

  // Translucent white overlays (glass morphism used heavily on gradients)
  white04: "rgba(255,255,255,0.04)",
  white05: "rgba(255,255,255,0.05)",
  white08: "rgba(255,255,255,0.08)",
  white10: "rgba(255,255,255,0.10)",
  white12: "rgba(255,255,255,0.12)",
  white15: "rgba(255,255,255,0.15)",
  white20: "rgba(255,255,255,0.20)",
  white40: "rgba(255,255,255,0.40)",
  white55: "rgba(255,255,255,0.55)",
  white60: "rgba(255,255,255,0.60)",
  white65: "rgba(255,255,255,0.65)",
  white70: "rgba(255,255,255,0.70)",
  white90: "rgba(255,255,255,0.90)",

  // Modal / sheet backdrop
  overlay40: "rgba(13,27,42,0.40)", // = foreground at 40% (spec §6.3)
} as const;

/**
 * Font families. Keys MUST match what `useAppFonts()` loads in lib/fonts.ts,
 * because expo-font uses the key string as the PostScript name.
 */
export const fonts = {
  // Plus Jakarta Sans (body)
  regular:    "PlusJakartaSans_400Regular",
  medium:     "PlusJakartaSans_500Medium",
  semibold:   "PlusJakartaSans_600SemiBold",
  bold:       "PlusJakartaSans_700Bold",
  extrabold:  "PlusJakartaSans_800ExtraBold",

  // Unbounded (headings + numbers)
  heading:       "Unbounded_700Bold",
  headingExtra:  "Unbounded_800ExtraBold",
  headingBlack:  "Unbounded_900Black",
} as const;

/**
 * Type scale used across the app (spec §3.5: "text-[9px] to text-[15px] are common").
 * These are suggestions — use raw numbers when the spec quotes a specific px value.
 */
export const fontSize = {
  xxs:     9,   // eyebrow labels ("ACTIVE · TODAY'S INDENT"), stats sublabels
  xs:      10,  // secondary captions, profile stats numbers
  sm:      11,  // body secondary, pill labels, window sub-text
  base:    12,  // body default, item names
  md:      13,  // emphasized body, bill total primary color
  lg:      15,  // agency name, prices in cards, totals
  xl:      17,  // screen titles in headers ("Review Indent")
  xxl:     18,  // splash headline, OTP page heading
  display: 20,  // splash "Indent Simplified" yellow accent
} as const;

/**
 * Spacing scale — mirrors Tailwind's 4px step with the fractional values the spec uses
 * (py-3.5 = 14px, mt-4.5 = 18px, gap-2.5 = 10px).
 */
export const spacing = {
  "0.5": 2,
  "1":   4,
  "1.5": 6,
  "2":   8,
  "2.5": 10,
  "3":   12,
  "3.5": 14,
  "4":   16,
  "4.5": 18,
  "5":   20,
  "6":   24,
  "7":   28,
  "8":   32,
  "10":  40,
  "11":  44,   // pt-11 — every screen header's top padding (clears status bar)
  "14":  56,
  "18":  72,
  "24":  96,   // pb-24 — scroll container when no floating cart
  "40":  160,  // pb-40 — scroll container when cart is present
} as const;

/**
 * Border radius. Spec: `--radius: 0.75rem` = 12px.
 * Tailwind's rounded-2xl = 16px, rounded-3xl = 24px, rounded-[22px] used on splash logo tile.
 */
export const radius = {
  sm:  6,     // rounded-md
  md:  10,    // rounded-lg
  lg:  12,    // rounded-xl === --radius
  xl:  14,
  xxl: 16,    // rounded-2xl (the most common)
  "3xl": 24,  // rounded-3xl — LocationPicker sheet, WindowClosed card
  "22": 22,   // splash logo tile rounded-[22px]
  "20": 20,   // WindowClosedContent countdown card rounded-[20px]
  full: 999,
} as const;

/**
 * Shadow presets translated to RN's shadow* props + Android elevation.
 *
 * The spec has dual-layer shadows (CSS supports it, RN doesn't), so we pick the more
 * visible layer of each. The color is an approximation of rgba(10,25,60,X).
 */
export const shadows = {
  sm: {
    shadowColor: "#0A193C",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 2,
  },
  md: {
    shadowColor: "#0A193C",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.10,
    shadowRadius: 12,
    elevation: 4,
  },
  lg: {
    shadowColor: "#0A193C",
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.15,
    shadowRadius: 24,
    elevation: 10,
  },
  /** Special upward shadow for the fixed BottomNav (spec §6.1) */
  bottomNav: {
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.06,
    shadowRadius: 20,
    elevation: 8,
  },
} as const;

/**
 * Gradient presets. Every gradient used in the app lives here so each screen can
 * `import { gradients } from "@/lib/theme"` and stay consistent.
 *
 * `colors` and `locations` go directly on <LinearGradient>; `angle` is fed through
 * `cssAngleToPoints()` to compute start/end.
 */
export const gradients = {
  /** Dashboard header · OPEN state (spec §6.2: 155deg primary → primaryDark) */
  headerOpen:     { colors: ["#1448CC", "#0D33A0"], angle: 155 },
  /** Dashboard header · CLOSING state (155deg amber) */
  headerClosing:  { colors: ["#92400E", "#B45309"], angle: 155 },
  /** Dashboard header · CLOSED state (155deg dark night) */
  headerClosed:   { colors: ["#111827", "#1F2937"], angle: 155 },

  /** Full-screen splash (spec §5.1 — 165deg, 3 stops) */
  splash: {
    colors: ["#1448CC", "#0D2B8F", "#061A6B"],
    locations: [0, 0.55, 1],
    angle: 165,
  },

  /** OTP / Login page header (spec §5.1 — 145deg) */
  otpHeader:      { colors: ["#1448CC", "#0D2B8F"], angle: 145 },

  /** Profile page header (spec §5.5 — 155deg) */
  profileHeader:  { colors: ["#1448CC", "#0D33A0"], angle: 155 },

  /** Orders page "active order" hero card (spec §5.3) */
  activeOrder:    { colors: ["#1448CC", "#0D33A0"], angle: 155 },

  /** Invoices page GST Summary card (spec §5.4) */
  invoiceSummary: { colors: ["#1448CC", "#0D33A0"], angle: 155 },

  /** Promo banner variants (spec §6.4 — 145deg) */
  bannerBrand: { colors: ["#1448CC", "#0D33A0"], angle: 145 },
  bannerGreen: { colors: ["#065F46", "#047857"], angle: 145 },
  bannerAmber: { colors: ["#92400E", "#B45309"], angle: 145 },
} as const;

/**
 * Convert a CSS linear-gradient angle (deg) into expo-linear-gradient {start, end} points.
 *
 * CSS convention: 0° points UP, 90° RIGHT, 180° DOWN. Gradient flows from
 * opposite-of-angle → angle direction.
 */
export function cssAngleToPoints(angleDeg: number) {
  const rad = (angleDeg * Math.PI) / 180;
  const dx = Math.sin(rad);
  const dy = -Math.cos(rad);
  return {
    start: { x: 0.5 - 0.5 * dx, y: 0.5 - 0.5 * dy },
    end:   { x: 0.5 + 0.5 * dx, y: 0.5 + 0.5 * dy },
  };
}

/**
 * Keyframe animation durations (spec §3.4). Used with Reanimated withRepeat/withTiming.
 * Added now so all components in later phases reference the same timings.
 */
export const animations = {
  livepulseMs:      1800,  // open-window green pulse
  livepulseAmberMs: 1400,
  livepulseFastMs:  1000,  // closing-window yellow pulse (faster)
  successPopMs:     600,   // order-confirmed scale burst
} as const;

/** Minimum hit-area per spec §3.3 (.tap-target) */
export const tapTarget = { minHeight: 44, minWidth: 44 } as const;

/**
 * Common style snippets that appear verbatim across many components.
 * Use by spreading: `style={[cardBase, { marginTop: 12 }]}`
 */
export const cardBase = {
  backgroundColor: colors.card,
  borderRadius: radius.xxl,
  padding: spacing["3.5"],
  ...shadows.sm,
} as const;