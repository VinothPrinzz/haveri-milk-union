"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAuthStore } from "@/lib/auth-store";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const login = useAuthStore((s) => s.login);
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await login(email, password);
      router.replace("/dashboard");
    } catch (err: any) {
      setError(err?.data?.message || "Login failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-xl bg-brand text-white text-2xl mb-3">
            🐄
          </div>
          <h1 className="font-display text-lg font-bold text-fg">
            Haveri Milk Union
          </h1>
          <p className="text-xs text-muted-fg font-medium mt-1">
            ERP System · Admin Login
          </p>
        </div>

        {/* Login Card */}
        <div className="bg-card rounded-xl border border-border shadow-card p-6">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-[10px] font-bold text-muted-fg uppercase tracking-wider mb-1.5">
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="admin@haverimunion.coop"
                className="w-full bg-background border border-border rounded-lg px-3 py-2.5 text-[13px] font-semibold text-fg outline-none focus:border-brand focus:ring-1 focus:ring-brand/20 transition-colors"
                required
              />
            </div>
            <div>
              <label className="block text-[10px] font-bold text-muted-fg uppercase tracking-wider mb-1.5">
                Password
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full bg-background border border-border rounded-lg px-3 py-2.5 text-[13px] font-semibold text-fg outline-none focus:border-brand focus:ring-1 focus:ring-brand/20 transition-colors"
                required
              />
            </div>

            {error && (
              <div className="bg-danger/10 border border-danger/20 rounded-lg px-3 py-2 text-[11px] font-semibold text-danger">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-brand text-white rounded-lg py-2.5 text-[13px] font-bold hover:bg-brand/90 transition-colors disabled:opacity-50"
            >
              {loading ? "Signing in..." : "Sign In"}
            </button>
          </form>
        </div>

        <p className="text-center text-[10px] text-muted-fg mt-4">
          v1.0 · Haveri Milk Union ERP
        </p>
      </div>
    </div>
  );
}
