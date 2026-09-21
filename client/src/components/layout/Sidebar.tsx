import { useState, useEffect } from "react";
import {
  LayoutDashboard,
  Cog,
  Activity,
  ScrollText,
  Puzzle,
  ChevronLeft,
  ChevronRight,
  Wifi,
  WifiOff,
  Radio,
  Globe,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useNavStore, useConnectionStore, useJobEventsStore } from "@/stores/app";
import { backend } from "@/lib/backend";
import { api } from "@/lib/api";
import { useWindowDrag } from "@/lib/window-drag";

interface SidebarProps {
  version: string | null;
}

interface PluginInfo {
  id: string;
  name: string;
  enabled: boolean;
  sidebar?: boolean;
  icon?: string;
}

const navItems = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { id: "services", label: "Services", icon: Cog },
  { id: "processes", label: "Processes", icon: Activity },
  { id: "logs", label: "Logs", icon: ScrollText },
  { id: "plugins", label: "Plugins", icon: Puzzle },
];

// Map plugin icon names to lucide components
const pluginIconMap: Record<string, any> = {
  globe: Globe,
};

export function Sidebar({ version }: SidebarProps) {
  const currentPage = useNavStore((s) => s.currentPage);
  const setPage = useNavStore((s) => s.setPage);
  const sidebarCollapsed = useNavStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useNavStore((s) => s.toggleSidebar);
  const unseenJobEvents = useJobEventsStore((s) => s.unseen);
  const wsConnected = useConnectionStore((s) => s.wsConnected);
  const lastDataAt = useConnectionStore((s) => s.lastDataAt);
  const dataSource = useConnectionStore((s) => s.dataSource);
  const [sidebarPlugins, setSidebarPlugins] = useState<PluginInfo[]>([]);

  // Fetch plugins that should appear in sidebar
  useEffect(() => {
    if (backend.isDesktop()) return; // No plugin API in desktop mode
    const fetchPlugins = () => {
      api
        .get<{ plugins: PluginInfo[] }>("/plugins")
        .then((r) => {
          setSidebarPlugins(r.plugins.filter((p) => p.enabled && p.sidebar));
        })
        .catch(() => {});
    };
    fetchPlugins();
    const interval = setInterval(fetchPlugins, 60000);
    return () => clearInterval(interval);
  }, []);

  const isReceivingData =
    lastDataAt !== null && Date.now() - lastDataAt < 10000;

  const statusText = isReceivingData
    ? dataSource === "ws"
      ? "Live (WS)"
      : "Live (Poll)"
    : wsConnected
      ? "Connected"
      : "No data";

  const statusColor = isReceivingData
    ? "text-green-400 bg-green-500/5"
    : wsConnected
      ? "text-cyan-400 bg-cyan-500/5"
      : "text-amber-400 bg-amber-500/5";

  const StatusIcon = isReceivingData ? Radio : wsConnected ? Wifi : WifiOff;

  const handleDrag = useWindowDrag();

  return (
    <aside
      className={cn(
        "fixed left-0 top-0 h-screen glass border-r border-white/[0.06] z-50 flex flex-col transition-all duration-300",
        sidebarCollapsed ? "w-16" : "w-56"
      )}
    >
      {/* Native titlebar space (traffic lights area on macOS). Empty, so the attribute is enough. */}
      {backend.isDesktop() && (
        <div data-tauri-drag-region className="h-8 w-full flex-shrink-0" />
      )}
      {/* Logo + drag region. The attribute covers the row background.
          The mousedown fallback covers the logo and the title text. */}
      <div
        data-tauri-drag-region
        onMouseDown={handleDrag}
        className="flex items-center gap-3 px-4 h-12 border-b border-white/[0.06] select-none"
      >
        <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center flex-shrink-0">
          <Activity className="w-4 h-4 text-white" aria-hidden="true" />
        </div>
        {!sidebarCollapsed && (
          <div className="flex flex-col">
            <span className="text-sm font-bold text-white tracking-tight">
              mac-dash
            </span>
            <span className="text-[10px] text-gray-500">
              {version ? `v${version}` : "system manager"}
            </span>
          </div>
        )}
      </div>

      {/* Navigation */}
      <nav aria-label="Main" className="flex-1 p-2 space-y-1">
        {navItems.map((item) => {
          const isActive = currentPage === item.id;
          // launchd job changes that the user has not opened yet
          const badge = item.id === "services" && unseenJobEvents > 0 ? unseenJobEvents : 0;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setPage(item.id)}
              aria-label={badge ? `${item.label}, ${badge} new job changes` : item.label}
              title={item.label}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/60",
                isActive
                  ? "bg-cyan-500/10 text-cyan-400 shadow-[0_0_12px_rgba(6,182,212,0.1)]"
                  : "text-gray-400 hover:text-gray-200 hover:bg-white/[0.04]"
              )}
            >
              <item.icon
                aria-hidden="true"
                className={cn("w-[18px] h-[18px] flex-shrink-0", isActive && "drop-shadow-[0_0_4px_rgba(6,182,212,0.5)]")}
              />
              {!sidebarCollapsed && (
                <span className="font-medium">{item.label}</span>
              )}
              {badge > 0 && (
                <span
                  aria-hidden="true"
                  className={cn(
                    "rounded-full bg-amber-400 text-[10px] font-bold text-amber-950 inline-flex items-center justify-center",
                    sidebarCollapsed ? "absolute ml-5 -mt-5 h-2 w-2" : "ml-auto min-w-4 h-4 px-1"
                  )}
                >
                  {!sidebarCollapsed && badge}
                </span>
              )}
            </button>
          );
        })}

        {/* Plugin sidebar entries */}
        {sidebarPlugins.length > 0 && (
          <>
            {!sidebarCollapsed && (
              <div className="text-[10px] text-gray-600 uppercase tracking-wider px-3 pt-3 pb-1 font-medium">
                Plugins
              </div>
            )}
            {sidebarPlugins.map((plugin) => {
              const pageId = `plugin:${plugin.id}`;
              const isActive = currentPage === pageId;
              const Icon = pluginIconMap[plugin.icon || ""] || Puzzle;
              return (
                <button
                  key={pageId}
                  type="button"
                  onClick={() => setPage(pageId)}
                  aria-label={plugin.name}
                  title={plugin.name}
                  aria-current={isActive ? "page" : undefined}
                  className={cn(
                    "w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-500/60",
                    isActive
                      ? "bg-purple-500/10 text-purple-400 shadow-[0_0_12px_rgba(168,85,247,0.1)]"
                      : "text-gray-400 hover:text-gray-200 hover:bg-white/[0.04]"
                  )}
                >
                  <Icon
                    aria-hidden="true"
                    className={cn("w-[18px] h-[18px] flex-shrink-0", isActive && "drop-shadow-[0_0_4px_rgba(168,85,247,0.5)]")}
                  />
                  {!sidebarCollapsed && (
                    <span className="font-medium">{plugin.name}</span>
                  )}
                </button>
              );
            })}
          </>
        )}
      </nav>

      {/* Footer */}
      <div className="p-3 space-y-2 border-t border-white/[0.06]">
        {/* Connection status */}
        <div
          title={`Connection: ${statusText}`}
          className={cn(
            "flex items-center gap-2 px-3 py-2 rounded-lg text-xs",
            statusColor
          )}
        >
          <StatusIcon
            aria-hidden="true"
            className={cn("w-3.5 h-3.5 flex-shrink-0", isReceivingData && "animate-pulse")}
          />
          {/* The text stays available to assistive technology when the sidebar is collapsed. */}
          <span className={cn(sidebarCollapsed && "sr-only")}>{statusText}</span>
        </div>

        {/* Collapse toggle */}
        <button
          type="button"
          onClick={toggleSidebar}
          aria-label="Toggle sidebar"
          title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!sidebarCollapsed}
          className="w-full flex items-center justify-center py-1.5 rounded-lg text-gray-500 hover:text-gray-300 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/60"
        >
          {sidebarCollapsed ? (
            <ChevronRight className="w-4 h-4" aria-hidden="true" />
          ) : (
            <ChevronLeft className="w-4 h-4" aria-hidden="true" />
          )}
        </button>
      </div>
    </aside>
  );
}
