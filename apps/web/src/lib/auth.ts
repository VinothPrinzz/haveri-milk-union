// ══════════════════════════════════════════════════════════════════
// Auth — admin session management (cookie-based, server-side sessions)
// ══════════════════════════════════════════════════════════════════

import { createContext, useContext, useEffect, useState } from "react";
import { post, get } from "@/lib/apiClient";

export interface AdminUser {
  id:       string;
  name:     string;
  username: string;   // ← replaces email as the login identifier
  email:    string;   // kept — still useful for display / notifications
  role:     string;
  zoneId:   string | null;
}

interface AuthContextValue {
  user:    AdminUser | null;
  loading: boolean;
  login:   (username: string, password: string) => Promise<void>;
  logout:  () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue>({
  user:    null,
  loading: true,
  login:   async () => {},
  logout:  async () => {},
});

export function useAuth() {
  return useContext(AuthContext);
}

/** Send username + password, store session token, return the user object. */
export async function loginAdmin(
  username: string,
  password: string,
): Promise<AdminUser> {
  const data = await post<{ user: AdminUser; sessionToken: string }>(
    "/auth/admin/login",
    { username, password },   // ← was: { email, password }
  );
  if (data.sessionToken) {
    localStorage.setItem("hmu_session", data.sessionToken);
  }
  return data.user;
}

export async function logoutAdmin(): Promise<void> {
  await post("/auth/admin/logout");
  localStorage.removeItem("hmu_session");
}

export async function getMe(): Promise<AdminUser | null> {
  try {
    const data = await get<{ user: AdminUser }>("/auth/admin/me");
    return data.user;
  } catch {
    return null;
  }
}

/** Change the logged-in admin's own password (verifies the current one). */
export async function changeAdminPassword(
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  await post("/auth/admin/change-password", { currentPassword, newPassword });
}