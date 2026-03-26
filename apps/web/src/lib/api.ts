const API_BASE = process.env.NEXT_PUBLIC_API_URL || "";

interface FetchOptions extends RequestInit {
  params?: Record<string, string | number | undefined>;
}

class ApiError extends Error {
  status: number;
  data: any;
  constructor(status: number, data: any) {
    super(data?.message || `API Error ${status}`);
    this.status = status;
    this.data = data;
  }
}

async function fetchApi<T = any>(
  path: string,
  options: FetchOptions = {}
): Promise<T> {
  const { params, ...init } = options;

  // Build URL with query params
  let url = `${API_BASE}${path}`;
  if (params) {
    const searchParams = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined) searchParams.set(k, String(v));
    });
    const qs = searchParams.toString();
    if (qs) url += `?${qs}`;
  }

  // Get session token from cookie or localStorage
  const sessionToken =
    typeof window !== "undefined"
      ? localStorage.getItem("hmu_session") ?? ""
      : "";

  const res = await fetch(url, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(sessionToken ? { "x-session-token": sessionToken } : {}),
      ...init.headers,
    },
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, data);
  }

  return res.json();
}

// ── Convenience methods ──
export const api = {
  get: <T = any>(path: string, params?: Record<string, any>) =>
    fetchApi<T>(path, { method: "GET", params }),

  post: <T = any>(path: string, body?: any) =>
    fetchApi<T>(path, { method: "POST", body: JSON.stringify(body) }),

  patch: <T = any>(path: string, body?: any) =>
    fetchApi<T>(path, { method: "PATCH", body: JSON.stringify(body) }),

  put: <T = any>(path: string, body?: any) =>
    fetchApi<T>(path, { method: "PUT", body: JSON.stringify(body) }),

  delete: <T = any>(path: string) =>
    fetchApi<T>(path, { method: "DELETE" }),
};

export { ApiError };
