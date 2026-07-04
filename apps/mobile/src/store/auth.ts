// src/store/auth.ts  —  FULL FILE (drop-in replacement)
//
// WHAT CHANGED & WHY
//   1. login() fetches /dealer/profile right after saving tokens so the
//      top bar (name / zone / code) is populated on first paint.
//   2. initialize() no longer blocks app boot on the network: it decides
//      auth from local storage instantly (persisted session + token) and
//      refreshes the profile in the background with retries.
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
import { createJSONStorage, persist } from "zustand/middleware";
import {
  api,
  saveTokens,
  clearTokens,
  loadToken,
  getStorage,
  ApiError,
} from "../lib/api";
import { useCartStore } from "./cart";
import { useTargetDateStore } from "./targetDate";
import type { Dealer } from "../lib/types";

/**
 * Persist storage for this store. zustand's persist() defaults to
 * window.localStorage, which does NOT exist in React Native — so on a real
 * device nothing was ever actually persisted: every cold start began
 * logged-out and the app blocked on a profile fetch over the network
 * before letting the dealer in. Backing the store with the same storage
 * the tokens already use (SecureStore on native, localStorage on web)
 * makes the session + dealer snapshot genuinely survive restarts, which
 * is what lets initialize() enter the app instantly without the network.
 * The persisted payload (isAuthenticated + dealer, see partialize) is a
 * few hundred bytes — well under SecureStore's 2 KB Android guideline.
 */
const authStorage = createJSONStorage(() => ({
  getItem: async (name: string) => (await getStorage()).getItemAsync(name),
  setItem: async (name: string, value: string) => {
    await (await getStorage()).setItemAsync(name, value);
  },
  removeItem: async (name: string) => {
    await (await getStorage()).deleteItemAsync(name);
  },
}));

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

/**
 * Wipe every client-side, account-scoped store so one dealer's data can
 * never bleed into the next: the React Query cache (registered by App.tsx
 * above), the in-memory cart, and the target-order date. Called on every
 * session boundary — login (a new session begins), logout and forceLogout
 * (a session ends).
 *
 * The cart is the important addition here: it's a plain in-memory zustand
 * store with no per-account key, so logging out of A and into B on the
 * SAME app launch used to leave A's cart — and its "View indent" bar —
 * sitting under B's account until the app process was killed. The query
 * cache reset already covered the server-side indent draft; the cart and
 * target date were the missing pieces.
 */
function resetSessionScopedState(): void {
  resetQueryCache?.();
  useCartStore.getState().clearCart();
  useTargetDateStore.getState().resetToToday();
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

async function fetchProfile(networkRetries = 0): Promise<Dealer | null> {
  const data = await api<{ dealer: Record<string, unknown> }>(
    "/api/v1/dealer/profile",
    { networkRetries }
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
        // Boot must NEVER block on the network. The old version awaited a
        // profile fetch (15s timeout ×2) behind the full-screen loader; on
        // a slow link the dealer stared at "Loading…" for ~30s and was
        // then dumped at the login screen despite holding a valid session.
        // Now: decide from local storage instantly, refresh in background.
        try {
          // One deterministic hydration pass (skipHydration is set below).
          // This is a local storage read — milliseconds, not network. A
          // corrupt/unreadable snapshot must not block entry: the token
          // check below still decides, and the profile refresh repopulates.
          try {
            await useAuthStore.persist.rehydrate();
          } catch {
            // ignore — proceed with whatever state we have
          }

          const token = await loadToken();

          if (!token) {
            // No session — go to splash immediately, zero network.
            set({ isAuthenticated: false, dealer: null, isLoading: false });
            return;
          }

          // A token exists → let the dealer straight in with the persisted
          // profile snapshot. Screens hydrate section-by-section from their
          // own queries (skeletons while pending).
          set({ isAuthenticated: true, isLoading: false });

          // Background profile refresh with retries. Failure is fine —
          // the persisted snapshot keeps the header populated, and
          // refetch-on-reconnect/foreground heals the rest.
          try {
            const dealer = await fetchProfile(2);
            if (dealer) set({ dealer });
          } catch (err) {
            if (err instanceof ApiError && err.status === 401) {
              // Session truly dead (refresh rotation failed too) — route
              // back to splash.
              await clearTokens();
              set({ isAuthenticated: false, dealer: null });
            }
            // Network/timeout: stay in the app with cached data.
          }
        } finally {
          set({ isLoading: false });
        }
      },

      // Username + Password login.
      login: async (username: string, password: string) => {
        set({ isLoading: true });
        try {
          // Login is the critical first request over a cold rural link, so
          // it gets RETRIES, not just a long timeout. One do-or-die 25s
          // attempt punished slow-but-working connections: the request was
          // aborted at the cliff and the dealer saw "Connection Problem"
          // even though a retry would have succeeded. Now: 4 attempts
          // (15s → 22.5s → 30s → 30s) with backoff — slow internet feels
          // slow, but signs in; it no longer hard-fails.
          //
          // Retrying login is safe: a duplicate success just inserts an
          // extra refresh-token row server-side, and a 401 (wrong
          // credentials) is an HTTP error, which networkRetries never
          // retries.
          const res = await api<{
            accessToken: string;
            refreshToken: string;
            dealer: Record<string, unknown>;
          }>("/api/v1/auth/dealer/login", {
            method: "POST",
            body: { username, password },
            timeoutMs: 15000,
            networkRetries: 3,
          });

          await saveTokens(res.accessToken, res.refreshToken);

          // New session begins — wipe every account-scoped client store
          // (query cache, cart, target date) left over from a previous
          // account BEFORE we fetch this dealer's profile or route to any
          // of their screens, so no stale data from the last login — not
          // even a lingering cart — can flash through.
          resetSessionScopedState();

          // The login response may only contain { id, phone } (older API).
          // Always fetch the full profile so name/zone/code are present on
          // the very first paint — no manual reload needed.
          let dealer = parseDealer(res.dealer ?? {});
          try {
            const full = await fetchProfile(1);
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
        // Drop every account-scoped client store (query cache, cart,
        // target date) so the next account starts clean.
        resetSessionScopedState();
        set({ dealer: null, isAuthenticated: false });
      },

      forceLogout: () => {
        // Fire-and-forget token wipe; the session is already invalid so
        // we don't await it — clearing state immediately is what matters.
        void clearTokens();
        resetSessionScopedState();
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
      storage: authStorage,
      // initialize() rehydrates explicitly before reading state, so the
      // async auto-rehydrate can't race it and clobber what it sets.
      skipHydration: true,
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