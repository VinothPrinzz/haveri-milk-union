import { Platform } from "react-native";

/**
 * HMU Dealer API Client
 *
 * Thin fetch wrapper with:
 *   - Platform-aware token storage (SecureStore on native, localStorage on web)
 *   - Bearer-token injection
 *   - Refresh-token rotation on 401 (single-flight, no loops)
 *   - Per-request timeout via AbortController (default 15s)
 *   - Opt-in retry on pure network failure with escalating timeouts
 *     (RequestOptions.networkRetries) — for slow rural connections
 *   - Proper Error subclass (ApiError) so stack traces and error boundaries work
 *
 * Backend endpoints (verified against /mnt/project/api.txt):
 *   POST /api/v1/auth/dealer/request-otp   body { phone }
 *   POST /api/v1/auth/dealer/verify-otp    body { phone, otp }      -> { accessToken, refreshToken, dealer }
 *   POST /api/v1/auth/dealer/refresh       body { refreshToken }    -> { accessToken, refreshToken }
 */

// Storage abstraction --------------------------------------------------

type Storage = {
  getItemAsync: (key: string) => Promise<string | null>;
  setItemAsync: (key: string, value: string) => Promise<void>;
  deleteItemAsync: (key: string) => Promise<void>;
};

let storagePromise: Promise<Storage> | null = null;

export function getStorage(): Promise<Storage> {
  if (storagePromise) return storagePromise;

  storagePromise = (async (): Promise<Storage> => {
    if (Platform.OS === "web") {
      return {
        getItemAsync:    async (k) => (typeof localStorage !== "undefined" ? localStorage.getItem(k) : null),
        setItemAsync:    async (k, v) => { if (typeof localStorage !== "undefined") localStorage.setItem(k, v); },
        deleteItemAsync: async (k) => { if (typeof localStorage !== "undefined") localStorage.removeItem(k); },
      };
    }
    const secureStore = await import("expo-secure-store");
    return secureStore as unknown as Storage;
  })();

  return storagePromise;
}

// Base URL -------------------------------------------------------------

function getBaseUrl(): string {
  const fromEnv = process.env.EXPO_PUBLIC_API_URL;
  if (fromEnv) return fromEnv;
  if (Platform.OS === "web") return "http://localhost:3001";
  // Android emulator maps host localhost to 10.0.2.2
  return "http://10.0.2.2:3001";
}

export const API_BASE = getBaseUrl();
// Default per-request network timeout. Raised from 8s so ordinary screens
// survive "a bit slow" dealer connections (cold connection = DNS + TLS +
// round-trip can eat several seconds before any data flows). Individual
// requests can override this via RequestOptions.timeoutMs — login uses a
// longer budget since it's the critical first request over a cold link.
const TIMEOUT_MS = 15000;
// Ceiling for the escalating per-attempt timeout used by networkRetries.
const MAX_TIMEOUT_MS = 30000;
// Base pause between retry attempts (multiplied by the attempt number).
const RETRY_BACKOFF_MS = 1000;

// Connection warm-up ----------------------------------------------------
//
// A cold HTTPS connection costs DNS + TCP + TLS — several round trips
// before the first byte of a real request is sent. On a weak rural signal
// that handshake alone can eat many seconds (or fail), which is why login
// used to die with "Connection Problem" while WhatsApp (persistent socket,
// no per-request handshake) kept working. Firing a tiny health-check as
// soon as the splash/login screen appears performs that handshake while
// the dealer is still typing, so the actual login POST reuses the already
// open connection (fetch on Android pools keep-alive connections via
// OkHttp). Fire-and-forget: failures are irrelevant — the real request
// will simply open its own connection like before.

let lastWarmUpAt = 0;

export function warmUpConnection(): void {
  const now = Date.now();
  if (now - lastWarmUpAt < 60_000) return; // at most once a minute
  lastWarmUpAt = now;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 10_000);
  fetch(`${API_BASE}/api/v1/health`, { signal: controller.signal })
    .catch(() => {
      // Ignore — this is purely an opportunistic TLS warm-up.
    })
    .finally(() => clearTimeout(t));
}

// Error type -----------------------------------------------------------

export class ApiError extends Error {
  public status: number;
  public body: unknown;
  constructor(status: number, body: unknown, message?: string) {
    const bodyMsg =
      body && typeof body === "object"
        ? (body as { message?: string; error?: string }).message ??
          (body as { message?: string; error?: string }).error
        : undefined;
    super(message ?? bodyMsg ?? `API ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

// Token management -----------------------------------------------------

const ACCESS_KEY  = "hmu_access_token";
const REFRESH_KEY = "hmu_refresh_token";

let accessToken: string | null = null;

/**
 * Refresh outcome. The distinction matters on slow connections:
 *   "refreshed" — new tokens saved, retry the original request.
 *   "invalid"   — the server rejected the refresh token; session is dead.
 *   "network"   — timeout / no connectivity; the session may be FINE.
 *                 Callers must surface this as a network error (status 0),
 *                 never as a 401 — otherwise a flaky signal logs the
 *                 dealer out even though their refresh token is valid.
 */
type RefreshResult = "refreshed" | "invalid" | "network";

let refreshing: Promise<RefreshResult> | null = null;

export async function loadToken(): Promise<string | null> {
  try {
    const store = await getStorage();
    accessToken = await store.getItemAsync(ACCESS_KEY);
  } catch {
    accessToken = null;
  }
  return accessToken;
}

export async function saveTokens(access: string, refresh: string): Promise<void> {
  accessToken = access;
  try {
    const store = await getStorage();
    await store.setItemAsync(ACCESS_KEY, access);
    await store.setItemAsync(REFRESH_KEY, refresh);
  } catch (err) {
    console.warn("[api] Failed to persist tokens:", err);
  }
}

export async function clearTokens(): Promise<void> {
  accessToken = null;
  try {
    const store = await getStorage();
    await store.deleteItemAsync(ACCESS_KEY);
    await store.deleteItemAsync(REFRESH_KEY);
  } catch {
    // noop
  }
}

/** Single-flight refresh — concurrent 401s share one refresh call. */
async function refreshAccessToken(): Promise<RefreshResult> {
  if (refreshing) return refreshing;

  refreshing = (async (): Promise<RefreshResult> => {
    try {
      const store = await getStorage();
      const refreshToken = await store.getItemAsync(REFRESH_KEY);
      if (!refreshToken) return "invalid";

      let res: Response;
      try {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
        try {
          res = await fetch(`${API_BASE}/api/v1/auth/dealer/refresh`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ refreshToken }),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(t);
        }
      } catch {
        // Timeout or no connectivity. The refresh token is very likely
        // still valid — do NOT clear it. Clearing here was silently
        // logging dealers out whenever a refresh raced a weak signal.
        return "network";
      }

      if (!res.ok) {
        await clearTokens();
        return "invalid";
      }
      const data = await res.json().catch(() => null);
      if (!data?.accessToken || !data?.refreshToken) {
        await clearTokens();
        return "invalid";
      }
      await saveTokens(data.accessToken, data.refreshToken);
      return "refreshed";
    } catch {
      // Unexpected local failure (storage). Treat as transient — never
      // destroy a possibly-valid session over it.
      return "network";
    } finally {
      setTimeout(() => { refreshing = null; }, 0);
    }
  })();

  return refreshing;
}

// Request --------------------------------------------------------------

type RequestOptions = {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  params?: Record<string, string | number | boolean | undefined | null>;
  /** Pass true to skip the auto-refresh retry (used internally + for auth endpoints) */
  skipAuthRetry?: boolean;
  /** Override the default network timeout (ms) for this request. */
  timeoutMs?: number;
  /**
   * Extra attempts on PURE network failure (ApiError status 0 — timeout or
   * no connectivity). HTTP errors (401/500/…) are never retried here.
   * Each retry waits a short backoff, then runs with a 1.5× longer
   * timeout (capped at MAX_TIMEOUT_MS): aborting a stalled socket and
   * opening a fresh one usually beats waiting on the dead one.
   *
   * ONLY set this on requests that are safe to repeat (GETs, login).
   * Never on order placement / payments — a timed-out request may still
   * have been processed by the server.
   */
  networkRetries?: number;
};

function buildUrl(path: string, params?: RequestOptions["params"]): string {
  let url = `${API_BASE}${path}`;
  if (params) {
    const entries = Object.entries(params).filter(
      ([, v]) => v !== undefined && v !== null && v !== ""
    );
    if (entries.length) {
      const qs = entries
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join("&");
      url += `?${qs}`;
    }
  }
  return url;
}

async function doFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number = TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Primary request function. All typed helpers below call this.
 *
 * Runs the request once via apiFetchOnce; if opts.networkRetries > 0 and
 * the failure was a pure network error (status 0), retries with backoff
 * and an escalating per-attempt timeout.
 *
 * @throws {ApiError} on non-2xx or network/timeout error
 */
export async function apiFetch<T = unknown>(
  path: string,
  opts: RequestOptions = {}
): Promise<T> {
  const { networkRetries = 0, ...rest } = opts;
  let attemptTimeout = rest.timeoutMs ?? TIMEOUT_MS;

  for (let attempt = 0; ; attempt++) {
    try {
      return await apiFetchOnce<T>(path, { ...rest, timeoutMs: attemptTimeout });
    } catch (err) {
      const isNetworkError = err instanceof ApiError && err.status === 0;
      if (!isNetworkError || attempt >= networkRetries) throw err;

      // Brief backoff (1s, 2s, …) — lets a congested radio link breathe —
      // then try again on a fresh connection with a longer budget.
      await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS * (attempt + 1)));
      attemptTimeout = Math.min(Math.round(attemptTimeout * 1.5), MAX_TIMEOUT_MS);
    }
  }
}

async function apiFetchOnce<T = unknown>(
  path: string,
  opts: RequestOptions = {}
): Promise<T> {
  const { method = "GET", body, params, skipAuthRetry = false, timeoutMs } = opts;

  const url = buildUrl(path, params);

  // Self-heal: the in-memory token can be null on the very first
  // requests after launch (initialize() race). Load it before
  // building headers so the first calls aren't sent unauthenticated.
  if (!accessToken && !skipAuthRetry) {
    await loadToken();
  }
  
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  // Always send a JSON body for non-GET methods so Fastify doesn't reject
  // when Content-Type is application/json but body is empty. Matches the
  // web admin's apiClient.ts pattern (post/patch/put always send `{}`).
  const hasBody = body !== undefined;
  const isWriteMethod = method !== "GET" && method !== "DELETE";
  const requestBody = hasBody
    ? JSON.stringify(body)
    : isWriteMethod
      ? "{}"
      : undefined;

  if (!hasBody && !isWriteMethod) {
    // GET/DELETE with no body → drop Content-Type to avoid pre-flight surprises
    delete headers["Content-Type"];
  }

  let res: Response;
  try {
    res = await doFetch(url, { method, headers, body: requestBody }, timeoutMs);
  } catch (err) {
    const isAbort = (err as { name?: string })?.name === "AbortError";
    throw new ApiError(0, null, isAbort ? "Request timed out" : "Network error");
  }

  // 401 + we have a token -> try one refresh
  if (res.status === 401 && accessToken && !skipAuthRetry) {
    const refreshResult = await refreshAccessToken();

    // Refresh couldn't reach the server — the session may well be alive.
    // Surface a network error (status 0), NOT the 401: the global 401
    // handler force-logs-out, and a weak signal must never do that.
    if (refreshResult === "network") {
      throw new ApiError(0, null, "Network error");
    }

    if (refreshResult === "refreshed" && accessToken) {
      headers.Authorization = `Bearer ${accessToken}`;

      // Use the SAME requestBody logic here
      const retryBody = hasBody
        ? JSON.stringify(body)
        : isWriteMethod
          ? "{}"
          : undefined;

      // Optionally re-apply the Content-Type deletion (rarely needed in retry, but consistent)
      if (!hasBody && !isWriteMethod) {
        delete headers["Content-Type"];
      } else {
        headers["Content-Type"] = "application/json"; // ensure it's back if needed
      }

      try {
        res = await doFetch(url, {
          method,
          headers,
          body: retryBody,
        }, timeoutMs);
      } catch (err) {
        const isAbort = (err as { name?: string })?.name === "AbortError";
        throw new ApiError(0, null, isAbort ? "Request timed out" : "Network error");
      }
    }
  }

  const data = await parseBody(res);

  if (!res.ok) throw new ApiError(res.status, data);
  return data as T;
}

// Convenience helpers --------------------------------------------------
// Backwards-compat: api.get(path, params) / api.post(path, body) etc.

type ApiFn = {
  <T = unknown>(path: string, opts?: RequestOptions): Promise<T>;
  get:    <T = unknown>(path: string, params?: RequestOptions["params"]) => Promise<T>;
  post:   <T = unknown>(path: string, body?: unknown) => Promise<T>;
  patch:  <T = unknown>(path: string, body?: unknown) => Promise<T>;
  put:    <T = unknown>(path: string, body?: unknown) => Promise<T>;
  delete: <T = unknown>(path: string) => Promise<T>;
};

export const api: ApiFn = Object.assign(
  <T = unknown>(path: string, opts: RequestOptions = {}) => apiFetch<T>(path, opts),
  {
    get:    <T = unknown>(path: string, params?: RequestOptions["params"]) => apiFetch<T>(path, { params }),
    post:   <T = unknown>(path: string, body?: unknown) => apiFetch<T>(path, { method: "POST",   body }),
    patch:  <T = unknown>(path: string, body?: unknown) => apiFetch<T>(path, { method: "PATCH",  body }),
    put:    <T = unknown>(path: string, body?: unknown) => apiFetch<T>(path, { method: "PUT",    body }),
    delete: <T = unknown>(path: string) => apiFetch<T>(path, { method: "DELETE" }),
  }
) as ApiFn;