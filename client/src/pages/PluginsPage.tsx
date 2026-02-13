import { useState, useEffect } from "react";
import { GlowCard } from "@/components/ui/GlowCard";
import { api } from "@/lib/api";
import {
  Puzzle,
  Power,
  PowerOff,
  RefreshCw,
  Plus,
  Package,
  Code2,
  Monitor,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { motion } from "framer-motion";

interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  icon?: string;
  enabled: boolean;
  hasClient: boolean;
  sidebar?: boolean;
  dashboardWidget?: boolean;
}

export function PluginsPage() {
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchPlugins = async () => {
    try {
      const res = await api.get<{ plugins: PluginInfo[] }>("/plugins");
      setPlugins(res.plugins);
    } catch {
      // Plugins endpoint may not have data yet
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPlugins();
  }, []);

  const handleDiscover = async () => {
    setLoading(true);
    try {
      await api.post("/plugins/discover");
      await fetchPlugins();
    } catch {
    } finally {
      setLoading(false);
    }
  };

  const handleToggle = async (plugin: PluginInfo) => {
    try {
      if (plugin.enabled) {
        await api.post(`/plugins/${plugin.id}/disable`);
      } else {
        await api.post(`/plugins/${plugin.id}/enable`);
      }
      await fetchPlugins();
    } catch {}
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Plugins</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Extend mac-dash with custom functionality
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleDiscover}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium bg-white/[0.04] text-gray-400 hover:text-gray-200 hover:bg-white/[0.08] transition-all"
          >
            <RefreshCw className={cn("w-3.5 h-3.5", loading && "animate-spin")} />
            Scan
          </button>
        </div>
      </div>

      {/* Plugin grid */}
      {plugins.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {plugins.map((plugin, i) => (
            <motion.div
              key={plugin.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.05 }}
            >
              <GlowCard
                hover
                className="space-y-3"
                glow={plugin.enabled ? "accent" : "none"}
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div
                      className={cn(
                        "w-10 h-10 rounded-xl flex items-center justify-center",
                        plugin.enabled
                          ? "bg-cyan-500/10"
                          : "bg-gray-500/10"
                      )}
                    >
                      <Puzzle
                        className={cn(
                          "w-5 h-5",
                          plugin.enabled ? "text-cyan-400" : "text-gray-500"
                        )}
                      />
                    </div>
                    <div>
                      <h3 className="text-sm font-semibold text-white">
                        {plugin.name}
                      </h3>
                      <span className="text-[10px] text-gray-600 font-mono">
                        v{plugin.version}
                      </span>
                    </div>
                  </div>
                  <button
                    onClick={() => handleToggle(plugin)}
                    className={cn(
                      "p-2 rounded-xl transition-all",
                      plugin.enabled
                        ? "bg-cyan-500/10 text-cyan-400 hover:bg-cyan-500/20"
                        : "bg-gray-500/10 text-gray-500 hover:bg-gray-500/20"
                    )}
                  >
                    {plugin.enabled ? (
                      <Power className="w-4 h-4" />
                    ) : (
                      <PowerOff className="w-4 h-4" />
                    )}
                  </button>
                </div>

                <p className="text-xs text-gray-400">{plugin.description}</p>

                <div className="flex gap-2">
                  {plugin.hasClient && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-purple-500/10 text-purple-400 text-[10px]">
                      <Monitor className="w-2.5 h-2.5" />
                      UI
                    </span>
                  )}
                  {plugin.sidebar && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-blue-500/10 text-blue-400 text-[10px]">
                      <Code2 className="w-2.5 h-2.5" />
                      Sidebar
                    </span>
                  )}
                  {plugin.dashboardWidget && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-amber-500/10 text-amber-400 text-[10px]">
                      <Package className="w-2.5 h-2.5" />
                      Widget
                    </span>
                  )}
                </div>
              </GlowCard>
            </motion.div>
          ))}
        </div>
      ) : (
        /* Empty state */
        <GlowCard className="text-center py-12">
          <div className="w-16 h-16 rounded-2xl bg-white/[0.03] flex items-center justify-center mx-auto mb-4">
            <Puzzle className="w-8 h-8 text-gray-600" />
          </div>
          <h3 className="text-lg font-semibold text-gray-400">No plugins installed</h3>
          <p className="text-sm text-gray-600 mt-2 max-w-md mx-auto">
            Create a plugin by adding a directory in <code className="text-cyan-400/70 font-mono text-xs bg-cyan-500/5 px-1.5 py-0.5 rounded">plugins/</code> with
            a <code className="text-cyan-400/70 font-mono text-xs bg-cyan-500/5 px-1.5 py-0.5 rounded">manifest.json</code> file.
          </p>

          <div className="mt-6 glass rounded-xl p-4 max-w-sm mx-auto text-left">
            <p className="text-xs text-gray-500 mb-2">Example manifest.json:</p>
            <pre className="text-[11px] font-mono text-gray-400 leading-relaxed">
{`{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "Does something cool",
  "icon": "wrench",
  "sidebar": true
}`}
            </pre>
          </div>
        </GlowCard>
      )}

      {/* How to create a plugin */}
      <GlowCard>
        <h3 className="text-sm font-semibold text-gray-300 mb-3">Creating a Plugin</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
          <div className="space-y-2">
            <div className="w-8 h-8 rounded-lg bg-cyan-500/10 flex items-center justify-center">
              <span className="text-cyan-400 font-bold">1</span>
            </div>
            <p className="text-gray-400">
              Create a folder in <code className="text-cyan-400/70 font-mono bg-cyan-500/5 px-1 rounded">plugins/</code> with a <code className="text-cyan-400/70 font-mono bg-cyan-500/5 px-1 rounded">manifest.json</code>
            </p>
          </div>
          <div className="space-y-2">
            <div className="w-8 h-8 rounded-lg bg-purple-500/10 flex items-center justify-center">
              <span className="text-purple-400 font-bold">2</span>
            </div>
            <p className="text-gray-400">
              Add <code className="text-purple-400/70 font-mono bg-purple-500/5 px-1 rounded">server.ts</code> to register API routes and/or <code className="text-purple-400/70 font-mono bg-purple-500/5 px-1 rounded">client.tsx</code> for UI
            </p>
          </div>
          <div className="space-y-2">
            <div className="w-8 h-8 rounded-lg bg-green-500/10 flex items-center justify-center">
              <span className="text-green-400 font-bold">3</span>
            </div>
            <p className="text-gray-400">
              Click <strong className="text-gray-300">Scan</strong> to discover your plugin, then enable it
            </p>
          </div>
        </div>
      </GlowCard>
    </div>
  );
}
