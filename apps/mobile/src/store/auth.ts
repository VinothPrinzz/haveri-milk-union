import { create } from "zustand";
import { api, saveTokens, clearTokens, loadToken } from "../lib/api";

interface Dealer {
  id: string;
  name: string;
  phone: string;
  zoneName: string;
  zoneId: string;
  walletBalance: number;
  locationLabel: string;
}

interface AuthState {
  dealer: Dealer | null;
  isLoading: boolean;
  isAuthenticated: boolean;

  initialize: () => Promise<void>;
  requestOtp: (phone: string) => Promise<{ message: string }>;
  verifyOtp: (phone: string, otp: string) => Promise<boolean>;
  logout: () => Promise<void>;
  refreshProfile: () => Promise<void>;
}

function parseDealer(d: any): Dealer {
  return {
    id: d.id,
    name: d.name,
    phone: d.phone,
    zoneName: d.zone_name || d.zoneName || "",
    zoneId: d.zone_id || d.zoneId || "",
    walletBalance: parseFloat(d.wallet_balance || d.walletBalance || "0"),
    locationLabel: d.location_label || d.locationLabel || "",
  };
}

export const useAuthStore = create<AuthState>((set) => ({
  dealer: null,
  isLoading: true,
  isAuthenticated: false,

  initialize: async () => {
    try {
      await loadToken();
      const data = await api("/api/v1/dealer/profile");
      if (data?.dealer) {
        set({ dealer: parseDealer(data.dealer), isAuthenticated: true, isLoading: false });
      } else {
        set({ isLoading: false });
      }
    } catch {
      // No valid token or API unreachable — go to splash
      set({ isLoading: false });
    }
  },

  requestOtp: async (phone: string) => {
    return await api.post("/api/v1/auth/dealer/request-otp", { phone });
  },

  verifyOtp: async (phone: string, otp: string) => {
    // Step 1: Verify OTP and get tokens
    const data = await api.post("/api/v1/auth/dealer/verify-otp", { phone, otp });

    // Step 2: Save tokens (works on both web and native)
    await saveTokens(data.accessToken, data.refreshToken);

    // Step 3: If the API returned dealer info directly, use it
    if (data.dealer) {
      set({ dealer: parseDealer(data.dealer), isAuthenticated: true });
      return true;
    }

    // Step 4: Otherwise fetch profile
    try {
      const profile = await api("/api/v1/dealer/profile");
      if (profile?.dealer) {
        set({ dealer: parseDealer(profile.dealer), isAuthenticated: true });
        return true;
      }
    } catch (profileErr) {
      console.warn("Profile fetch failed after login:", profileErr);
    }

    // Step 5: Even if profile fails, we have tokens — mark as authenticated
    set({ dealer: { id: "", name: phone, phone, zoneName: "", zoneId: "", walletBalance: 0, locationLabel: "" }, isAuthenticated: true });
    return true;
  },

  logout: async () => {
    await clearTokens();
    set({ dealer: null, isAuthenticated: false });
  },

  refreshProfile: async () => {
    try {
      const data = await api("/api/v1/dealer/profile");
      if (data?.dealer) {
        set({ dealer: parseDealer(data.dealer) });
      }
    } catch {}
  },
}));
