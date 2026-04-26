import { create } from "zustand";
import { api, saveTokens, clearTokens, loadToken, ApiError } from "../lib/api";
import type { Dealer, VerifyOtpResponse } from "../lib/types";

/**
 * Parses the backend's dealer row (snake_case) into our camelCase `Dealer` type.
 * Handles both shapes: the trim one from /verify-otp vs the full one from /dealer/profile.
 */
function parseDealer(d: Record<string, unknown>): Dealer {
  const get = <T>(k1: string, k2?: string): T | undefined => {
    const v = d[k1] ?? (k2 ? d[k2] : undefined);
    return v as T | undefined;
  };

  const walletRaw = get<string | number>("wallet_balance", "walletBalance");
  const walletBalance =
    typeof walletRaw === "string" ? parseFloat(walletRaw) :
    typeof walletRaw === "number" ? walletRaw : 0;

  const creditLimitRaw = get<string | number>("credit_limit", "creditLimit");
  const creditLimit =
    typeof creditLimitRaw === "string" ? parseFloat(creditLimitRaw) :
    typeof creditLimitRaw === "number" ? creditLimitRaw : 0;

  const creditOutRaw = get<string | number>("credit_outstanding", "creditOutstanding");
  const creditOutstanding =
    typeof creditOutRaw === "string" ? parseFloat(creditOutRaw) :
    typeof creditOutRaw === "number" ? creditOutRaw : 0;

  return {
    id:                    get<string>("id") ?? "",
    name:                  get<string>("name") ?? "",
    phone:                 get<string>("phone") ?? "",
    code:                  get<string>("code"),
    zoneId:                get<string>("zone_id", "zoneId") ?? "",
    zoneName:              get<string>("zone_name", "zoneName") ?? "",
    walletBalance,
    creditLimit,
    creditOutstanding,
    locationLabel:         get<string>("location_label", "locationLabel"),
    gstNumber:             get<string>("gst_number", "gstNumber"),
    address:               get<string>("address"),
    languagePref:          get<"en" | "kn">("language_pref", "languagePref"),
    notificationsEnabled:  get<boolean>("notifications_enabled", "notificationsEnabled"),
    biometricEnabled:      get<boolean>("biometric_enabled",     "biometricEnabled"),
    verified:              get<boolean>("verified"),
    memberSince:           get<string>("created_at", "memberSince"),
  };
}

interface AuthState {
  dealer: Dealer | null;
  isLoading: boolean;
  isAuthenticated: boolean;

  initialize:     () => Promise<void>;
  requestOtp:     (phone: string) => Promise<{ message: string; expiresIn: number; otp?: string }>;
  verifyOtp:      (phone: string, otp: string) => Promise<boolean>;
  logout:         () => Promise<void>;
  refreshProfile: () => Promise<void>;
  /** Merge partial dealer updates into the store (used after PATCH /dealers/:id) */
  patchDealer:    (patch: Partial<Dealer>) => void;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  dealer: null,
  isLoading: true,
  isAuthenticated: false,

  // Called once on app start — restores session if a valid token is stored.
  initialize: async () => {
    try {
      await loadToken();
      const data = await api.get<{ dealer: Record<string, unknown> }>("/api/v1/dealer/profile");
      if (data?.dealer) {
        set({ dealer: parseDealer(data.dealer), isAuthenticated: true, isLoading: false });
      } else {
        set({ isLoading: false });
      }
    } catch (err) {
      // Invalid token, network error, or no token at all — go to splash.
      if (err instanceof ApiError && err.status === 401) {
        await clearTokens();
      }
      set({ isLoading: false });
    }
  },

  requestOtp: async (phone) => {
    return api.post<{ message: string; expiresIn: number; otp?: string }>(
      "/api/v1/auth/dealer/request-otp",
      { phone }
    );
  },

  verifyOtp: async (phone, otp) => {
    const data = await api.post<VerifyOtpResponse>(
      "/api/v1/auth/dealer/verify-otp",
      { phone, otp }
    );

    await saveTokens(data.accessToken, data.refreshToken);

    // The verify endpoint returns a trimmed dealer object (id/name/phone/zoneId).
    // Fetch the full profile immediately so the home screen has everything it needs.
    try {
      const profile = await api.get<{ dealer: Record<string, unknown> }>("/api/v1/dealer/profile");
      if (profile?.dealer) {
        set({ dealer: parseDealer(profile.dealer), isAuthenticated: true });
        return true;
      }
    } catch (profileErr) {
      console.warn("[auth] Profile fetch failed after login:", profileErr);
    }

    // Fallback: use the trim dealer from the verify response.
    set({
      dealer: parseDealer(data.dealer as unknown as Record<string, unknown>),
      isAuthenticated: true,
    });
    return true;
  },

  logout: async () => {
    await clearTokens();
    set({ dealer: null, isAuthenticated: false });
  },

  refreshProfile: async () => {
    try {
      const data = await api.get<{ dealer: Record<string, unknown> }>("/api/v1/dealer/profile");
      if (data?.dealer) {
        set({ dealer: parseDealer(data.dealer) });
      }
    } catch {
      /* swallow — keep existing dealer */
    }
  },

  patchDealer: (patch) => {
    const current = get().dealer;
    if (!current) return;
    set({ dealer: { ...current, ...patch } });
  },
}));