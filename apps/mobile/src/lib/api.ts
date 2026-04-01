import { Platform } from "react-native";

// ── Storage abstraction (SecureStore on native, localStorage on web) ──
let SecureStore: any = null;

async function getStorage() {
  if (SecureStore) return SecureStore;
  if (Platform.OS === "web") {
    // Web fallback using localStorage
    SecureStore = {
      getItemAsync: async (key: string) => localStorage.getItem(key),
      setItemAsync: async (key: string, value: string) => localStorage.setItem(key, value),
      deleteItemAsync: async (key: string) => localStorage.removeItem(key),
    };
  } else {
    // Native: use expo-secure-store
    SecureStore = await import("expo-secure-store");
  }
  return SecureStore;
}

// ── API base URL ──
function getBaseUrl(): string {
  if (Platform.OS === "web") {
    // Web: same origin or explicit env
    return process.env.EXPO_PUBLIC_API_URL || "http://localhost:3001";
  }
  // Android emulator: 10.0.2.2 maps to host localhost
  // Physical device: use your machine's IP or tunnel URL
  return process.env.EXPO_PUBLIC_API_URL || "http://10.0.2.2:3001";
}

const API_BASE = getBaseUrl();

let accessToken: string | null = null;

export async function loadToken() {
  try {
    const store = await getStorage();
    accessToken = await store.getItemAsync("hmu_access_token");
  } catch {
    accessToken = null;
  }
}

export async function saveTokens(access: string, refresh: string) {
  accessToken = access;
  try {
    const store = await getStorage();
    await store.setItemAsync("hmu_access_token", access);
    await store.setItemAsync("hmu_refresh_token", refresh);
  } catch (err) {
    console.warn("Failed to persist tokens:", err);
    // Token is still in memory — app will work for this session
  }
}

export async function clearTokens() {
  accessToken = null;
  try {
    const store = await getStorage();
    await store.deleteItemAsync("hmu_access_token");
    await store.deleteItemAsync("hmu_refresh_token");
  } catch {}
}

async function refreshAccessToken(): Promise<boolean> {
  try {
    const store = await getStorage();
    const refreshToken = await store.getItemAsync("hmu_refresh_token");
    if (!refreshToken) return false;

    const res = await fetch(`${API_BASE}/api/v1/auth/dealer/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    await saveTokens(data.accessToken, data.refreshToken);
    return true;
  } catch {
    return false;
  }
}

export async function api(
  path: string,
  options: { method?: string; body?: any; params?: Record<string, any> } = {}
) {
  const { method = "GET", body, params } = options;

  let url = `${API_BASE}${path}`;
  if (params) {
    const entries = Object.entries(params).filter(
      ([_, v]) => v !== undefined && v !== null && v !== ""
    );
    if (entries.length > 0) {
      const qs = entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
      url += `?${qs}`;
    }
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;

  let res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  // Auto-refresh on 401
  if (res.status === 401 && accessToken) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      headers["Authorization"] = `Bearer ${accessToken}`;
      res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    }
  }

  const data = await res.json();
  if (!res.ok) throw { status: res.status, data };
  return data;
}

// Convenience methods
api.get = (path: string, params?: Record<string, any>) => api(path, { params });
api.post = (path: string, body: any) => api(path, { method: "POST", body });
api.patch = (path: string, body: any) => api(path, { method: "PATCH", body });
