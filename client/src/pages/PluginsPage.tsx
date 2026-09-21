import { Fragment, useState, useEffect, type ReactNode } from "react";
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
import { backend } from "@/lib/backend";
import { toast } from "@/components/ui/Toast";
import { t as translate, useT } from "@/i18n";

// The plugin runtime is a separate chunk. Do not pull it into the main bundle from here.
const clearPluginModuleCache = (pluginId?: string) =>
  import("@/lib/plugin-runtime").then((runtime) => runtime.clearPluginModuleCache(pluginId));

function errorMessage(e: unknown): string {
  return e instanceof Error && e.message ? e.message : translate("pages.plugins.unknownError");
}

/**
 * Splits a translated template on its `{token}` placeholders and substitutes rich nodes
 * (e.g. a styled `<code>` element) for them, so a single full sentence stays intact per
 * language instead of being assembled from separately-translated fragments.
 */
function withNodes(template: string, nodes: Record<string, ReactNode>): ReactNode {
  return template.split(/(\{\w+\})/g).map((part, i) => {
    const match = /^\{(\w+)\}$/.exec(part);
    if (match && match[1] in nodes) return <Fragment key={i}>{nodes[match[1]]}</Fragment>;
    return part;
  });
}

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
  const { t } = useT();
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  /** Throws when the request fails. Callers decide how to report it. */
  const fetchPlugins = async () => {
    const res = await api.get<{ plugins: PluginInfo[] }>("/plugins");
    setPlugins(res.plugins);
  };

  useEffect(() => {
    // Skip plugin loading in desktop mode
    if (backend.isDesktop()) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    fetchPlugins()
      .catch((e) => {
        if (!cancelled) toast.error(t("pages.plugins.loadFailedToast", { error: errorMessage(e) }));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleDiscover = async () => {
    setLoading(true);
    try {
      await api.post("/plugins/discover");
      // A rescan can pick up changed plugin code. Drop every cached module.
      clearPluginModuleCache();
      await fetchPlugins();
      toast.success(t("pages.plugins.scanFinishedToast"));
    } catch (e) {
      toast.error(t("pages.plugins.scanFailedToast", { error: errorMessage(e) }));
    } finally {
      setLoading(false);
    }
  };

  const handleToggle = async (plugin: PluginInfo) => {
    const action = plugin.enabled ? "disable" : "enable";
    setTogglingId(plugin.id);
    try {
      await api.post(`/plugins/${encodeURIComponent(plugin.id)}/${action}`);
      // The server rebuilds the client bundle after a disable/enable cycle.
      // Drop the cached module so the next render loads the fresh code.
      clearPluginModuleCache(plugin.id);
      await fetchPlugins();
      toast.success(
        t(plugin.enabled ? "pages.plugins.disabledToast" : "pages.plugins.enabledToast", { name: plugin.name })
      );
    } catch (e) {
      toast.error(
        t(plugin.enabled ? "pages.plugins.disableFailedToast" : "pages.plugins.enableFailedToast", {
          name: plugin.name,
          error: errorMessage(e),
        })
      );
    } finally {
      setTogglingId(null);
    }
  };

  // Desktop mode: Show info message instead
  if (backend.isDesktop()) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-white">{t("pages.plugins.title")}</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {t("pages.plugins.subtitle")}
          </p>
        </div>
        <GlowCard className="text-center py-12">
          <div className="w-16 h-16 rounded-2xl bg-cyan-500/10 flex items-center justify-center mx-auto mb-4">
            <Monitor className="w-8 h-8 text-cyan-400" />
          </div>
          <h3 className="text-lg font-semibold text-gray-300">{t("pages.plugins.desktopAppTitle")}</h3>
          <p className="text-sm text-gray-500 mt-2 max-w-md mx-auto">
            {t("pages.plugins.desktopAppDescription")}
          </p>
          <p className="text-xs text-gray-600 mt-4">
            {withNodes(t("pages.plugins.usePluginsHint"), {
              command: (
                <code className="text-cyan-400/70 font-mono bg-cyan-500/5 px-1.5 py-0.5 rounded">mac-dash serve</code>
              ),
            })}
          </p>
        </GlowCard>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">{t("pages.plugins.title")}</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {t("pages.plugins.subtitle")}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleDiscover}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium bg-white/[0.04] text-gray-400 hover:text-gray-200 hover:bg-white/[0.08] transition-all disabled:opacity-60"
          >
            <RefreshCw
              className={cn("w-3.5 h-3.5", loading && "animate-spin")}
              aria-hidden="true"
            />
            {t("pages.plugins.scanButton")}
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
                        v{plugin.version} &middot;{" "}
                        {plugin.enabled ? t("status.enabled") : t("status.disabled")}
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={plugin.enabled}
                    aria-label={t("pages.plugins.enabledSwitchAriaLabel", { name: plugin.name })}
                    title={plugin.enabled ? t("pages.plugins.disablePluginTitle") : t("pages.plugins.enablePluginTitle")}
                    disabled={togglingId === plugin.id}
                    onClick={() => handleToggle(plugin)}
                    className={cn(
                      "p-2 rounded-xl transition-all disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/60",
                      plugin.enabled
                        ? "bg-cyan-500/10 text-cyan-400 hover:bg-cyan-500/20"
                        : "bg-gray-500/10 text-gray-500 hover:bg-gray-500/20"
                    )}
                  >
                    {plugin.enabled ? (
                      <Power className="w-4 h-4" aria-hidden="true" />
                    ) : (
                      <PowerOff className="w-4 h-4" aria-hidden="true" />
                    )}
                  </button>
                </div>

                <p className="text-xs text-gray-400">{plugin.description}</p>

                <div className="flex gap-2">
                  {plugin.hasClient && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-purple-500/10 text-purple-400 text-[10px]">
                      <Monitor className="w-2.5 h-2.5" />
                      {t("pages.plugins.badgeUi")}
                    </span>
                  )}
                  {plugin.sidebar && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-blue-500/10 text-blue-400 text-[10px]">
                      <Code2 className="w-2.5 h-2.5" />
                      {t("pages.plugins.badgeSidebar")}
                    </span>
                  )}
                  {plugin.dashboardWidget && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-amber-500/10 text-amber-400 text-[10px]">
                      <Package className="w-2.5 h-2.5" />
                      {t("pages.plugins.badgeWidget")}
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
          <h3 className="text-lg font-semibold text-gray-400">{t("pages.plugins.noPluginsTitle")}</h3>
          <p className="text-sm text-gray-600 mt-2 max-w-md mx-auto">
            {withNodes(t("pages.plugins.emptyStateHint"), {
              dir: (
                <code className="text-cyan-400/70 font-mono text-xs bg-cyan-500/5 px-1.5 py-0.5 rounded">plugins/</code>
              ),
              file: (
                <code className="text-cyan-400/70 font-mono text-xs bg-cyan-500/5 px-1.5 py-0.5 rounded">manifest.json</code>
              ),
            })}
          </p>

          <div className="mt-6 glass rounded-xl p-4 max-w-sm mx-auto text-left">
            <p className="text-xs text-gray-500 mb-2">{t("pages.plugins.exampleManifestLabel")}</p>
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
        <h3 className="text-sm font-semibold text-gray-300 mb-3">{t("pages.plugins.creatingTitle")}</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
          <div className="space-y-2">
            <div className="w-8 h-8 rounded-lg bg-cyan-500/10 flex items-center justify-center">
              <span className="text-cyan-400 font-bold">1</span>
            </div>
            <p className="text-gray-400">
              {withNodes(t("pages.plugins.step1Hint"), {
                dir: <code className="text-cyan-400/70 font-mono bg-cyan-500/5 px-1 rounded">plugins/</code>,
                file: <code className="text-cyan-400/70 font-mono bg-cyan-500/5 px-1 rounded">manifest.json</code>,
              })}
            </p>
          </div>
          <div className="space-y-2">
            <div className="w-8 h-8 rounded-lg bg-purple-500/10 flex items-center justify-center">
              <span className="text-purple-400 font-bold">2</span>
            </div>
            <p className="text-gray-400">
              {withNodes(t("pages.plugins.step2Hint"), {
                serverFile: <code className="text-purple-400/70 font-mono bg-purple-500/5 px-1 rounded">server.ts</code>,
                clientFile: <code className="text-purple-400/70 font-mono bg-purple-500/5 px-1 rounded">client.tsx</code>,
              })}
            </p>
          </div>
          <div className="space-y-2">
            <div className="w-8 h-8 rounded-lg bg-green-500/10 flex items-center justify-center">
              <span className="text-green-400 font-bold">3</span>
            </div>
            <p className="text-gray-400">
              {withNodes(t("pages.plugins.step3Hint"), {
                scanLabel: <strong className="text-gray-300">{t("pages.plugins.scanButton")}</strong>,
              })}
            </p>
          </div>
        </div>
      </GlowCard>
    </div>
  );
}
