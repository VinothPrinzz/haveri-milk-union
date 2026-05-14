import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { User, Lock, AlertCircle, MessageCircle } from "lucide-react";

interface Props { onLogin: (username: string, password: string) => Promise<void>; }

// Place the farm image at:  public/assets/farm-bg.webp
const FARM_BG = "/assets/farm-bg.webp";

const VCS_NUMBERS = [
  { label: "9845326104", wa: "https://wa.me/919845326104" },
  { label: "9994074010", wa: "https://wa.me/919994074010" },
];

export default function LoginPage({ onLogin }: Props) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await onLogin(username, password);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Invalid credentials");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-stretch bg-background">

      {/* ── Left brand panel — farm image + overlay ── */}
      <div
        className="hidden md:flex md:w-1/2 flex-col justify-between p-10 relative overflow-hidden"
        style={{ minHeight: "100vh" }}
      >
        <img
          src={FARM_BG}
          alt="Dairy farm landscape"
          className="absolute inset-0 w-full h-full object-cover"
          style={{ objectPosition: "center 40%" }}
        />
        <div
          className="absolute inset-0"
          style={{
            background:
              "linear-gradient(to bottom, rgba(15,40,20,0.82) 0%, rgba(15,40,20,0.45) 40%, rgba(15,40,20,0.60) 70%, rgba(15,40,20,0.88) 100%)",
          }}
        />

        <div className="relative z-10 flex items-center gap-3">
          <div className="w-10 h-10 rounded-sm bg-white text-emerald-900 grid place-items-center font-bold text-lg shadow">
            H
          </div>
          <div>
            <div className="text-base font-semibold text-white">Haveri Milk Union</div>
            <div className="text-[11px] text-white/60">Marketing Module · v1.0</div>
          </div>
        </div>

        <div className="relative z-10">
          <h2 className="text-2xl font-semibold leading-tight text-white">
            Marketing Software Modules<br />for Milk Unions.
          </h2>
          <p className="text-white/70 mt-3 text-[13px] max-w-md">
            Customers, routes, indents, dispatch, stock and accounts managed in
            one place. Built for the daily rhythm of a co-operative milk union.
          </p>
          <div className="grid grid-cols-3 gap-2 mt-8 max-w-md">
            {["Indents", "Dispatch", "Stock", "Invoices", "Payments", "Reports"].map(s => (
              <div
                key={s}
                className="text-[11.5px] bg-white/15 backdrop-blur-sm border border-white/20 rounded-sm px-2 py-1.5 text-center text-white"
              >
                {s}
              </div>
            ))}
          </div>
        </div>

        <div className="relative z-10 text-[11px] text-white/50">
          © Haveri District Co-operative Milk Producers' Union Ltd.
        </div>
      </div>

      {/* ── Right panel ── */}
      <div className="flex-1 flex flex-col">
        <div className="flex-1 grid place-items-center p-6">
          <div className="w-full max-w-sm">

            <div className="md:hidden flex items-center gap-2 mb-6">
              <div className="w-8 h-8 rounded-sm bg-topbar text-topbar-foreground grid place-items-center font-bold">H</div>
              <span className="font-semibold">Haveri Milk Union</span>
            </div>

            <h1 className="text-[18px] font-semibold">Login</h1>

            <form onSubmit={handleSubmit} className="mt-6 space-y-3">
              <div>
                <label className="text-[11.5px] font-medium uppercase tracking-wide text-muted-foreground">
                  Username
                </label>
                <div className="relative mt-1">
                  <User className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                  <Input
                    type="text"
                    placeholder="e.g. admin"
                    value={username}
                    onChange={e => setUsername(e.target.value)}
                    required
                    autoFocus
                    autoComplete="username"
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
                    autoComplete="current-password"
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

        {/* Developer credit footer */}
        <div className="border-t border-border px-6 py-3 flex flex-col items-center gap-1.5">
          <p className="text-[11px] text-muted-foreground">
            Developed by{" "}
            <span className="font-semibold text-foreground">Vintage Computer Services</span>
          </p>
          <div className="flex items-center gap-3">
            {VCS_NUMBERS.map(({ label, wa }) => (
              <a
                key={label}
                href={wa}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-[11px] text-[#25D366] hover:text-[#1aab53] transition-colors font-medium"
                title={`Chat on WhatsApp: ${label}`}
              >
                <MessageCircle className="h-3 w-3" />
                {label}
              </a>
            ))}
          </div>
        </div>
      </div>

    </div>
  );
}