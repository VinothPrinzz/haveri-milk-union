import { useFonts as useExpoFonts } from "expo-font";
import {
  PlusJakartaSans_400Regular,
  PlusJakartaSans_500Medium,
  PlusJakartaSans_600SemiBold,
  PlusJakartaSans_700Bold,
  PlusJakartaSans_800ExtraBold,
} from "@expo-google-fonts/plus-jakarta-sans";
import {
  Unbounded_700Bold,
  Unbounded_800ExtraBold,
  Unbounded_900Black,
} from "@expo-google-fonts/unbounded";

/**
 * Loads the two font families used across the HMU dealer app:
 *   • Plus Jakarta Sans (body)  — 400, 500, 600, 700, 800
 *   • Unbounded        (heads)  — 700, 800, 900
 *
 * Usage in App.tsx:
 *
 *   export default function App() {
 *     const fontsReady = useAppFonts();
 *     if (!fontsReady) return <LoadingFallback />;
 *     return <AppContent />;
 *   }
 *
 * The keys are the EXACT strings referenced in lib/theme.ts → `fonts`.
 * Do not rename one without renaming the other.
 */
export function useAppFonts(): boolean {
  const [loaded] = useExpoFonts({
    PlusJakartaSans_400Regular,
    PlusJakartaSans_500Medium,
    PlusJakartaSans_600SemiBold,
    PlusJakartaSans_700Bold,
    PlusJakartaSans_800ExtraBold,
    Unbounded_700Bold,
    Unbounded_800ExtraBold,
    Unbounded_900Black,
  });
  return loaded;
}