import { useState, useEffect, type ComponentType } from "react";
import { loadPluginModule } from "@/lib/plugin-runtime";
import { Loader2, AlertTriangle, RefreshCw } from "lucide-react";

interface PluginRendererProps {
  pluginId: string;
}

/**
 * Dynamically loads and renders a plugin's client component.
 * Shows loading/error states while the plugin JS is fetched and evaluated.
 */
export function PluginRenderer({ pluginId }: PluginRendererProps) {
  const [Component, setComponent] = useState<ComponentType<any> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const mod = await loadPluginModule(pluginId);
      // Use a function updater to avoid React treating the component as a lazy init
      setComponent(() => mod.default);
    } catch (e: any) {
      console.error(`[PluginRenderer] Failed to load "${pluginId}":`, e);
      setError(e.message || "Failed to load plugin");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setComponent(null);
    load();
  }, [pluginId]);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3">
        <Loader2 className="w-6 h-6 text-cyan-400 animate-spin" />
        <p className="text-xs text-gray-500">Loading plugin...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3">
        <div className="w-12 h-12 rounded-xl bg-red-500/10 flex items-center justify-center">
          <AlertTriangle className="w-6 h-6 text-red-400" />
        </div>
        <p className="text-sm text-red-400 text-center max-w-md">{error}</p>
        <button
          onClick={load}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium bg-white/[0.04] text-gray-400 hover:text-gray-200 hover:bg-white/[0.08] transition-all mt-2"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Retry
        </button>
      </div>
    );
  }

  if (!Component) return null;

  return <Component />;
}
