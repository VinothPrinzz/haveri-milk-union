// Design tokens from dealer-app.html mockup
// Brand: hsl(222, 82%, 44%) = #1448CC
// Fonts: Plus Jakarta Sans (body), Unbounded (display/numbers)

export const colors = {
  brand: "#1448CC",
  brandLight: "#E8EEFB",
  brandLight2: "#C8D6F4",
  white: "#FFFFFF",
  bg: "#F5F5F5",
  card: "#FFFFFF",
  fg: "#0F172A",
  mutedFg: "#94A3B8",
  border: "#E2E8F0",

  success: "#16A34A",
  successLight: "#DCFCE7",
  warning: "#D97706",
  warningLight: "#FEF3C7",
  danger: "#DC2626",
  dangerLight: "#FEE2E2",
  info: "#0284C7",

  // Window states
  windowOpen: "#16A34A",
  windowWarning: "#92400E",
  windowClosed: "#1E293B",
} as const;

export const fonts = {
  regular: "PlusJakartaSans-Regular",
  medium: "PlusJakartaSans-Medium",
  semiBold: "PlusJakartaSans-SemiBold",
  bold: "PlusJakartaSans-Bold",
  extraBold: "PlusJakartaSans-ExtraBold",
  display: "Unbounded-Bold",
  displayBlack: "Unbounded-Black",
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  full: 999,
} as const;
