import { Platform } from "react-native";

/**
 * HMU Dealer API Client
 *
 * Thin fetch wrapper with:
 *   - Platform-aware token storage (SecureStore on native, localStorage on web)
 *   - Bearer-token injection
 *   - Refresh-token rotation on 401 (single-flight, no loops)
 *   - 8-second request timeout via AbortController
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

function getStorage(): Promise<Storage> {
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
const TIMEOUT_MS = 8000;

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
let refreshing: Promise<boolean> | null = null;

export async function loadToken(): Promise<void> {
  try {
    const store = await getStorage();
    accessToken = await store.getItemAsync(ACCESS_KEY);
  } catch {
    accessToken = null;
  }
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
async function refreshAccessToken(): Promise<boolean> {
  if (refreshing) return refreshing;

  refreshing = (async () => {
    try {
      const store = await getStorage();
      const refreshToken = await store.getItemAsync(REFRESH_KEY);
      if (!refreshToken) return false;

      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const res = await fetch(`${API_BASE}/api/v1/auth/dealer/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
        signal: controller.signal,
      });
      clearTimeout(t);

      if (!res.ok) {
        await clearTokens();
        return false;
      }
      const data = await res.json();
      if (!data?.accessToken || !data?.refreshToken) {
        await clearTokens();
        return false;
      }
      await saveTokens(data.accessToken, data.refreshToken);
      return true;
    } catch {
      await clearTokens();
      return false;
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

async function doFetch(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
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
 * @throws {ApiError} on non-2xx or network/timeout error
 */
export async function apiFetch<T = unknown>(
  path: string,
  opts: RequestOptions = {}
): Promise<T> {
  const { method = "GET", body, params, skipAuthRetry = false } = opts;

  const url = buildUrl(path, params);
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
    res = await doFetch(url, { method, headers, body: requestBody });
  } catch (err) {
    const isAbort = (err as { name?: string })?.name === "AbortError";
    throw new ApiError(0, null, isAbort ? "Request timed out" : "Network error");
  }

  // 401 + we have a token -> try one refresh
  if (res.status === 401 && accessToken && !skipAuthRetry) {
    const refreshed = await refreshAccessToken();
    if (refreshed && accessToken) {
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
        });
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