// src/store/auth.ts  —  FULL FILE (drop-in replacement)
//
// WHAT CHANGED & WHY
//   1. login() fetches /dealer/profile right after saving tokens so the
//      top bar (name / zone / code) is populated on first paint.
//   2. initialize() retries the profile fetch once on a transient
//      (network/timeout) error instead of silently leaving dealer = null.
//   3. NEW: forceLogout() — a synchronous, side-effect-free logout used
//      when a session is detected as dead (ApiError 401) from anywhere
//      in the app. Unlike logout(), it does NOT call the logout endpoint
//      (the session is already gone), it just clears local state so the
//      navigation shell routes back to the splash/login screen.
//   4. NEW: initialize()'s 401 branches now also flip isAuthenticated to
//      false and clear the dealer. Previously a stale persisted
//      `isAuthenticated: true` could survive a cold start with a dead
//      session, leaving the user on logged-in screens that error.

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { api, saveTokens, clearTokens, loadToken, ApiError } from "../lib/api";
import type { Dealer } from "../lib/types";

/**
 * Parses the backend dealer object into our camelCase Dealer type.
 *
 * Note: zoneId falls back to "" when absent. useWindowStatus already
 * guards with `enabled: !!zoneId`, so an empty string is harmless — it
 * simply disables the window query. The real cause of the empty zoneId
 * (login returning no zone) is fixed by login() below now fetching the
 * full profile.
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

  const creditAvailRaw = get<string | number>("credit_available", "creditAvailable");
  const creditAvailable =
    typeof creditAvailRaw === "string" ? parseFloat(creditAvailRaw) :
    typeof creditAvailRaw === "number" ? creditAvailRaw : undefined;

  // === FIX D: Add ledger balance ===
  const ledgerRaw = get<string | number>("ledger_balance", "ledgerBalance");
  const ledgerBalance =
    typeof ledgerRaw === "string" ? parseFloat(ledgerRaw) :
    typeof ledgerRaw === "number" ? ledgerRaw : 0;

  return {
    id:                    get<string>("id") ?? "",
    name:                  get<string>("name") ?? "",
    phone:                 get<string>("phone") ?? "",
    username:              get<string>("username"),
    code:                  get<string>("code"),
    zoneId:                get<string>("zone_id", "zoneId") ?? "",
    zoneName:              get<string>("zone_name", "zoneName") ?? "",
    routeId:               get<string>("route_id", "routeId") ?? "",
    routeName:             get<string>("route_name", "routeName") ?? "",
    routeCode:             get<string>("route_code", "routeCode") ?? "",
    routeDispatchTime:     get<string>("route_dispatch_time", "routeDispatchTime"),
    walletBalance,
    creditLimit,
    creditOutstanding,
    creditAvailable,
    ledgerBalance,
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

/** True if the dealer object actually has display-worthy data. */
function isHydratedDealer(d: Dealer | null | undefined): boolean {
  return !!d && (!!d.name || !!d.zoneName);
}

/**
 * The React Query cache lives in App.tsx's QueryClient, which this store
 * can't import without a circular dependency. Instead App.tsx registers a
 * reset callback here at startup. We invoke it whenever a session ENDS
 * (logout / forced logout) or a new one BEGINS (login) so the previous
 * dealer's cached orders / invoices / draft / notifications can never bleed
 * into the next account. Without this, logging out of A and into B on the
 * same app launch showed A's cached data until each query happened to
 * refetch. Safe no-op until App.tsx wires it up.
 */
let resetQueryCache: (() => void) | null = null;
export function setQueryCacheReset(fn: () => void): void {
  resetQueryCache = fn;
}

interface AuthState {
  dealer: Dealer | null;
  isLoading: boolean;
  isAuthenticated: boolean;

  initialize: () => Promise<void>;
  login: (username: string, password: string) => Promise<boolean>;
  logout: () => Promise<void>;
  /**
   * Clears local auth state immediately, without hitting the logout
   * endpoint. Use this when the session is already known to be dead
   * (e.g. a global ApiError 401 handler). It is safe to call multiple
   * times — flipping isAuthenticated to false is idempotent.
   */
  forceLogout: () => void;
  refreshProfile: () => Promise<void>;
  patchDealer: (patch: Partial<Dealer>) => void;
}

async function fetchProfile(): Promise<Dealer | null> {
  const data = await api.get<{ dealer: Record<string, unknown> }>(
    "/api/v1/dealer/profile"
  );
  return data?.dealer ? parseDealer(data.dealer) : null;
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

          // Fetch the profile; retry once on a transient failure so a
          // single network blip on cold start doesn't leave the header
          // permanently blank.
          let dealer: Dealer | null = null;
          try {
            dealer = await fetchProfile();
          } catch (err) {
            if (err instanceof ApiError && err.status === 401) {
              // Session is dead — clear tokens AND auth state so the
              // navigation shell routes to splash on a cold start.
              await clearTokens();
              set({ isAuthenticated: false, dealer: null });
              return;
            }
            // network / timeout — retry once
            dealer = await fetchProfile();
          }

          if (dealer) {
            set({ dealer, isAuthenticated: true });
          }
        } catch (err) {
          if (err instanceof ApiError && err.status === 401) {
            await clearTokens();
            set({ isAuthenticated: false, dealer: null });
          }
          // Any other error: keep whatever was rehydrated from storage.
          // refreshProfile() (pull-to-refresh) will heal it.
        } finally {
          set({ isLoading: false });
        }
      },

      // Username + Password login.
      login: async (username: string, password: string) => {
        set({ isLoading: true });
        try {
          // Give login a longer timeout than the default: it's the first
          // request over a cold connection (DNS + TLS + round-trip) and a
          // dealer on slow rural internet must be able to sign in. Uses the
          // base api() callable so we can pass a per-request timeoutMs.
          const res = await api<{
            accessToken: string;
            refreshToken: string;
            dealer: Record<string, unknown>;
          }>("/api/v1/auth/dealer/login", {
            method: "POST",
            body: { username, password },
            timeoutMs: 25000,
          });

          await saveTokens(res.accessToken, res.refreshToken);

          // New session begins — wipe any query cache left over from a
          // previous account BEFORE we fetch this dealer's profile or route
          // to any of their screens, so no stale data from the last login
          // can flash through.
          resetQueryCache?.();

          // The login response may only contain { id, phone } (older API).
          // Always fetch the full profile so name/zone/code are present on
          // the very first paint — no manual reload needed.
          let dealer = parseDealer(res.dealer ?? {});
          try {
            const full = await fetchProfile();
            if (full) dealer = full;
          } catch {
            // Profile fetch failed — fall back to the login payload.
            // refreshProfile() / next launch will fill in the rest.
          }

          set({ dealer, isAuthenticated: true, isLoading: false });
          return true;
        } catch (err) {
          console.error("Login failed:", err);
          set({ isLoading: false });
          // Only a genuine 401 means the credentials are wrong — return
          // false so the screen shows "Invalid username or password".
          // Every other failure (timeout / network = ApiError status 0, or
          // a 5xx) is NOT the user's fault, so rethrow and let the screen
          // surface an accurate "check your connection" message instead of
          // wrongly blaming their username/password on slow internet.
          if (err instanceof ApiError && err.status === 401) {
            return false;
          }
          throw err;
        }
      },

      logout: async () => {
        await clearTokens();
        // Drop every cached query so the next account starts clean.
        resetQueryCache?.();
        set({ dealer: null, isAuthenticated: false });
      },

      forceLogout: () => {
        // Fire-and-forget token wipe; the session is already invalid so
        // we don't await it — clearing state immediately is what matters.
        void clearTokens();
        resetQueryCache?.();
        set({ dealer: null, isAuthenticated: false, isLoading: false });
      },

      refreshProfile: async () => {
        try {
          const dealer = await fetchProfile();
          if (dealer) set({ dealer });
        } catch (err) {
          // A 401 here means the session died — surface it as a logout
          // so the user isn't left on a stale screen. Other errors are
          // swallowed (keep existing dealer data).
          if (err instanceof ApiError && err.status === 401) {
            get().forceLogout();
          }
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
      // If a stale/skimpy dealer was persisted, don't let it block
      // initialize() — initialize() always re-fetches and overwrites.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<AuthState>;
        return {
          ...current,
          ...p,
          // Prefer a hydrated dealer; never downgrade to a skimpy one.
          dealer: isHydratedDealer(p.dealer) ? p.dealer! : current.dealer,
        };
      },
    }
  )
);