import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { KeyRound, Loader2 } from "lucide-react";
import { backend } from "@/lib/backend";
import { UNAUTHORIZED_EVENT, authHeaders, setToken } from "@/lib/auth";

type State = "checking" | "open" | "locked";

/** Asks for the access token when the server requires one. Loopback servers and the desktop app never do. */
export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>(backend.isDesktop() ? "open" : "checking");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const check = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch("/api/auth/status", { headers: authHeaders() });
      if (!res.ok) return true; // an older server has no such route and no token
      const status = (await res.json()) as { required?: boolean; ok?: boolean };
      return !status.required || status.ok === true;
    } catch {
      return true; // offline: the app shows its own connection state
    }
  }, []);

  useEffect(() => {
    if (backend.isDesktop()) return;
    check().then((ok) => setState(ok ? "open" : "locked"));
    const lock = () => setState("locked");
    window.addEventListener(UNAUTHORIZED_EVENT, lock);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, lock);
  }, [check]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setToken(value.trim());
    if (await check()) {
      window.location.reload(); // every store and socket starts again with the token
      return;
    }
    setToken(null);
    setError("The server rejected this token.");
    setBusy(false);
  };

  if (state === "open") return <>{children}</>;
  if (state === "checking") {
    return (
      <div className="min-h-screen flex items-center justify-center text-gray-500" role="status">
        <Loader2 className="w-5 h-5 animate-spin" aria-hidden />
        <span className="sr-only">Connecting</span>
      </div>
    );
  }

  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <form onSubmit={submit} className="glass w-full max-w-sm rounded-2xl border border-white/[0.08] p-6 space-y-4">
        <div className="flex items-center gap-3">
          <span className="w-10 h-10 rounded-xl bg-cyan-500/10 flex items-center justify-center">
            <KeyRound className="w-5 h-5 text-cyan-400" aria-hidden />
          </span>
          <div>
            <h1 className="text-lg font-bold text-white">mac-dash</h1>
            <p className="text-xs text-gray-500">This server is open to the network and asks for its access token.</p>
          </div>
        </div>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-gray-400">Access token</span>
          <input
            type="password"
            autoComplete="current-password"
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-invalid={error !== null}
            className="w-full px-3 py-2 rounded-xl bg-white/[0.04] border border-white/[0.08] text-sm font-mono text-gray-200 focus:outline-none focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/20"
          />
        </label>
        {error && (
          <p role="alert" className="text-xs text-red-400">
            {error}
          </p>
        )}
        <p className="text-[11px] text-gray-600">
          The server prints the token when it starts. It is also in <span className="font-mono">~/.macdash/token</span> on the Mac that runs it.
        </p>
        <button
          type="submit"
          disabled={busy || value.trim() === ""}
          className="w-full px-4 py-2 rounded-xl text-sm font-medium text-cyan-950 bg-cyan-400 hover:bg-cyan-300 disabled:opacity-40"
        >
          {busy ? "Checking…" : "Unlock"}
        </button>
      </form>
    </main>
  );
}
