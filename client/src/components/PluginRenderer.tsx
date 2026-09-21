import { useState, useEffect, type ComponentType } from "react";
import { Loader2, AlertTriangle, RefreshCw } from "lucide-react";

interface PluginRendererProps {
  pluginId: string;
}

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; Component: ComponentType<any> };

/**
 * Dynamically loads and renders a plugin's client component.
 * Shows loading/error states while the plugin JS is fetched and evaluated.
 */
export function PluginRenderer({ pluginId }: PluginRendererProps) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  // Incremented by the Retry button to run the load effect again
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // A late result for a previous plugin must not overwrite the current one.
    let cancelled = false;
    setState({ status: "loading" });

    // The runtime exposes every lucide icon to plugins (about 1 MB). Load it only when a plugin is opened.
    import("@/lib/plugin-runtime")
      .then((runtime) => {
        runtime.initPluginRuntime();
        return runtime.loadPluginModule(pluginId);
      })
      .then((mod) => {
        if (cancelled) return;
        setState({ status: "ready", Component: mod.default });
      })
      .catch((e: any) => {
        if (cancelled) return;
        // Plugin authors need the stack trace. The UI shows only the message.
        console.error(`[PluginRenderer] Failed to load "${pluginId}":`, e);
        setState({
          status: "error",
          message: e?.message || "Failed to load plugin",
        });
      });

    return () => {
      cancelled = true;
    };
  }, [pluginId, attempt]);

  if (state.status === "loading") {
    return (
      <div
        role="status"
        className="flex flex-col items-center justify-center h-64 gap-3"
      >
        <Loader2 className="w-6 h-6 text-cyan-400 animate-spin" aria-hidden="true" />
        <p className="text-xs text-gray-500">Loading plugin...</p>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div
        role="alert"
        className="flex flex-col items-center justify-center h-64 gap-3"
      >
        <div className="w-12 h-12 rounded-xl bg-red-500/10 flex items-center justify-center">
          <AlertTriangle className="w-6 h-6 text-red-400" aria-hidden="true" />
        </div>
        <p className="text-sm text-red-400 text-center max-w-md">
          {state.message}
        </p>
        <button
          type="button"
          onClick={() => setAttempt((n) => n + 1)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium bg-white/[0.04] text-gray-400 hover:text-gray-200 hover:bg-white/[0.08] transition-all mt-2"
        >
          <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
          Retry
        </button>
      </div>
    );
  }

  const { Component } = state;
  return <Component />;
}
