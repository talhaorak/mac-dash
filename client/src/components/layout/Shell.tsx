import type { ReactNode } from "react";
import { Sidebar } from "./Sidebar";
import { useNavStore, useConnectionStore } from "@/stores/app";
import { cn } from "@/lib/utils";
import { RefreshCw, Clock } from "lucide-react";
import { useState, useEffect, useCallback } from "react";
import { backend } from "@/lib/backend";
import { startDesktopWindowDrag } from "@/lib/window-drag";

/** Drag handler that works for container + child elements */
function useWindowDrag() {
  return useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button, a, input, textarea, select, [role=button], [data-no-drag], .no-drag")) return;
    if (!backend.isDesktop()) return;
    e.preventDefault();
    void startDesktopWindowDrag(e.screenX, e.screenY);
  }, []);
}

interface ShellProps {
  children: ReactNode;
  version: string | null;
  onRefresh: () => void;
}

function formatLastUpdate(ts: number | null): string {
  if (!ts) return "never";
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 3) return "just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return new Date(ts).toLocaleTimeString();
}

export function Shell({ children, version, onRefresh }: ShellProps) {
  const { sidebarCollapsed } = useNavStore();
  const lastDataAt = useConnectionStore((s) => s.lastDataAt);
  const [, setTick] = useState(0);
  const onDrag = useWindowDrag();

  // Update the "ago" text every second
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="min-h-screen bg-bg-primary">
      <Sidebar version={version} />
      <main
        className={cn(
          "transition-all duration-300 min-h-screen",
          sidebarCollapsed ? "ml-16" : "ml-56",
          backend.isDesktop() && "pt-8" // Reserve titlebar area for traffic lights
        )}
      >
        {/* Top status bar */}
        <div
          onMouseDown={onDrag}
          className="sticky top-0 z-40 backdrop-blur-md bg-bg-primary/80 border-b border-white/[0.04] px-6 py-2 flex items-center gap-3"
        >
          {backend.isDesktop() && (
            <div
              className="h-6 flex-1"
            />
          )}
          <div
            className="flex items-center gap-1.5 text-xs text-gray-500 select-none"
          >
            <Clock className="w-3 h-3" />
            <span>Updated {formatLastUpdate(lastDataAt)}</span>
          </div>
          <button
            onClick={onRefresh}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs text-gray-400 hover:text-cyan-400 hover:bg-cyan-500/5 transition-all no-drag"
            title="Refresh now"
          >
            <RefreshCw className="w-3 h-3" />
            Refresh
          </button>
          {backend.isDesktop() && (
            <div
              className="h-6 w-10"
            />
          )}
        </div>
        <div className="p-6">{children}</div>
      </main>
    </div>
  );
}
