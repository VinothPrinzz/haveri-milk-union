import { useState, useEffect, useCallback } from "react";
import { 
  AuthContext, 
  getMe, 
  loginAdmin,     // ← Add this import
  logoutAdmin, 
  type AdminUser 
} from "@/lib/auth";

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AdminUser | null>(null);
  const [loading, setLoading] = useState(true);

  // On mount: check if already logged in (cookie still valid)
  useEffect(() => {
    getMe()
      .then(u => setUser(u))
      .finally(() => setLoading(false));
  }, []);

  // ✅ FIXED: This now actually performs login
  const login = useCallback(async (email: string, password: string) => {
    const loggedInUser = await loginAdmin(email, password);
    setUser(loggedInUser);        // Update React state
  }, []);

  const logout = useCallback(async () => {
    await logoutAdmin();
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}