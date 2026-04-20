// ══════════════════════════════════════════════════════════════════
// Auth — admin session management (cookie-based, server-side sessions)
// ══════════════════════════════════════════════════════════════════

import { createContext, useContext, useEffect, useState } from "react";
import { post, get } from "@/lib/apiClient";

export interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: string;
  zoneId: string | null;
}

interface AuthContextValue {
  user: AdminUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue>({
  user: null,
  loading: true,
  login: async () => {},
  logout: async () => {},
});

export function useAuth() {
  return useContext(AuthContext);
}

export async function loginAdmin(email: string, password: string): Promise<AdminUser> {
  const data = await post<{ user: AdminUser }>("/auth/admin/login", { email, password });
  return data.user;
}

export async function logoutAdmin(): Promise<void> {
  await post("/auth/admin/logout");
}

export async function getMe(): Promise<AdminUser | null> {
  try {
    const data = await get<{ user: AdminUser }>("/auth/admin/me");
    return data.user;
  } catch {
    return null;
  }
}
