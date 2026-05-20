import { create } from "zustand";
import { persist } from "zustand/middleware";
import { api, saveTokens, clearTokens, loadToken, ApiError } from "../lib/api";
import type { Dealer } from "../lib/types";

/**
 * Parses the backend dealer object into our camelCase Dealer type.
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
    username:              get<string>("username"),
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
    biometricEnabled:      get<boolean>("biometric_enabled", "biometricEnabled"),
    verified:              get<boolean>("verified"),
    memberSince:           get<string>("created_at", "memberSince"),
  };
}

interface AuthState {
  dealer: Dealer | null;
  isLoading: boolean;
  isAuthenticated: boolean;

  initialize: () => Promise<void>;
  login: (username: string, password: string) => Promise<boolean>;
  logout: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  patchDealer: (patch: Partial<Dealer>) => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      dealer: null,
      isLoading: true,
      isAuthenticated: false,

      initialize: async () => {
        try {
          await loadToken();
          const data = await api.get<{ dealer: Record<string, unknown> }>("/api/v1/dealer/profile");
          if (data?.dealer) {
            set({ dealer: parseDealer(data.dealer), isAuthenticated: true });
          }
        } catch (err) {
          if (err instanceof ApiError && err.status === 401) {
            await clearTokens();
          }
        } finally {
          set({ isLoading: false });
        }
      },

      // New Username + Password Login
      login: async (username: string, password: string) => {
        set({ isLoading: true });
        try {
          const res = await api.post<{
            accessToken: string;
            refreshToken: string;
            dealer: Record<string, unknown>;
          }>("/api/v1/auth/dealer/login", { username, password });

          await saveTokens(res.accessToken, res.refreshToken);

          set({
            dealer: parseDealer(res.dealer),
            isAuthenticated: true,
            isLoading: false,
          });

          return true;
        } catch (err) {
          console.error("Login failed:", err);
          set({ isLoading: false });
          return false;
        }
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
          // swallow — keep existing dealer data
        }
      },

      patchDealer: (patch) => {
        const current = get().dealer;
        if (!current) return;
        set({ dealer: { ...current, ...patch } });
      },
    }),

    {
      name: "hmu-dealer-auth",
      partialize: (state) => ({
        isAuthenticated: state.isAuthenticated,
        dealer: state.dealer,
      }),
    }
  )
);