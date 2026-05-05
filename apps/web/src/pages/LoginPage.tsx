import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Mail, Lock, AlertCircle } from "lucide-react";

interface Props { onLogin: (email: string, password: string) => Promise<void>; }

export default function LoginPage({ onLogin }: Props) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await onLogin(email, password);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Invalid credentials");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-stretch bg-background">
      {/* Left brand panel */}
      <div className="hidden md:flex md:w-1/2 bg-topbar text-topbar-foreground flex-col justify-between p-10">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-sm bg-white text-topbar grid place-items-center font-bold text-lg">H</div>
          <div>
            <div className="text-base font-semibold">Haveri Milk Union</div>
            <div className="text-[11px] opacity-70">Marketing Module · v1.0</div>
          </div>
        </div>
        <div>
          <h2 className="text-2xl font-semibold leading-tight">
            A complete enterprise<br />system for your union.
          </h2>
          <p className="text-white/70 mt-3 text-[13px] max-w-md">
            Customers, routes, indents, dispatch, stock and accounts — managed in
            one place. Built for the daily rhythm of a co-operative milk union.
          </p>
          <div className="grid grid-cols-3 gap-2 mt-8 max-w-md">
            {["Indents", "Dispatch", "Stock", "Invoices", "Payments", "Reports"].map(s => (
              <div key={s} className="text-[11.5px] bg-white/10 rounded-sm px-2 py-1.5 text-center">{s}</div>
            ))}
          </div>
        </div>
        <div className="text-[11px] opacity-60">© Haveri District Co-operative Milk Producers' Union Ltd.</div>
      </div>

      {/* Right form */}
      <div className="flex-1 grid place-items-center p-6">
        <div className="w-full max-w-sm">
          <div className="md:hidden flex items-center gap-2 mb-6">
            <div className="w-8 h-8 rounded-sm bg-topbar text-topbar-foreground grid place-items-center font-bold">H</div>
            <span className="font-semibold">Haveri Milk Union</span>
          </div>
          <h1 className="text-[18px] font-semibold">Sign in to continue</h1>
          <p className="text-[12.5px] text-muted-foreground mt-1">
            Use your ERP credentials issued by the administrator.
          </p>

          <form onSubmit={handleSubmit} className="mt-6 space-y-3">
            <div>
              <label className="text-[11.5px] font-medium uppercase tracking-wide text-muted-foreground">
                Email
              </label>
              <div className="relative mt-1">
                <Mail className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  type="email"
                  placeholder="admin@haverimunion.coop"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  required
                  autoFocus
                  className="erp-input pl-8"
                />
              </div>
            </div>
            <div>
              <label className="text-[11.5px] font-medium uppercase tracking-wide text-muted-foreground">
                Password
              </label>
              <div className="relative mt-1">
                <Lock className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  type="password"
                  placeholder="••••••••"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  required
                  className="erp-input pl-8"
                />
              </div>
            </div>
            {error && (
              <div className="flex items-start gap-2 text-[12px] text-destructive bg-destructive/10 border border-destructive/30 rounded-sm px-3 py-2">
                <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}
            <Button
              type="submit"
              disabled={loading}
              className="w-full bg-primary hover:bg-primary-hover text-primary-foreground h-9 rounded-sm"
            >
              {loading ? "Signing in…" : "Sign In"}
            </Button>
          </form>

          <p className="text-[11px] text-center text-muted-foreground mt-6">
            v1.0 · Co-operative Internal Use
          </p>
        </div>
      </div>
    </div>
  );
}