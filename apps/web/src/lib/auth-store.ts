"use client";
import { create } from "zustand";
import { api } from "./api";

interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: string;
  zoneId: string | null;
}

interface AuthState {
  user: AdminUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  checkSession: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  loading: true,

  login: async (email, password) => {
    const res = await api.post("/api/v1/auth/admin/login", { email, password });
    if (res.sessionToken) {
      localStorage.setItem("hmu_session", res.sessionToken);
    }
    set({ user: res.user, loading: false });
  },

  logout: async () => {
    try {
      await api.post("/api/v1/auth/admin/logout");
    } catch {}
    localStorage.removeItem("hmu_session");
    set({ user: null, loading: false });
  },

  checkSession: async () => {
    try {
      const res = await api.get("/api/v1/auth/admin/me");
      set({ user: res.user, loading: false });
    } catch {
      localStorage.removeItem("hmu_session");
      set({ user: null, loading: false });
    }
  },
}));
