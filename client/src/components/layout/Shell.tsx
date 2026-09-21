import { useState, useEffect, type ReactNode } from "react";
import { Sidebar } from "./Sidebar";
import { useNavStore, useConnectionStore } from "@/stores/app";
import { cn } from "@/lib/utils";
import { RefreshCw, Clock } from "lucide-react";
import { backend } from "@/lib/backend";
import { useWindowDrag } from "@/lib/window-drag";

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
  const sidebarCollapsed = useNavStore((s) => s.sidebarCollapsed);
  const lastDataAt = useConnectionStore((s) => s.lastDataAt);
  const [, setTick] = useState(0);
  const onDrag = useWindowDrag();
  const isDesktop = backend.isDesktop();

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
          sidebarCollapsed ? "ml-16" : "ml-56"
        )}
      >
        {/* Native titlebar area (desktop). Empty, so the attribute makes it draggable. */}
        {isDesktop && <div data-tauri-drag-region className="h-8 w-full" />}

        {/* Top status bar. The attribute covers the bar background and the spacers.
            The mousedown fallback covers the non-interactive children. */}
        <div
          data-tauri-drag-region
          onMouseDown={onDrag}
          className="sticky top-0 z-40 backdrop-blur-md bg-bg-primary/80 border-b border-white/[0.04] px-6 py-2 flex items-center gap-3"
        >
          {isDesktop && <div data-tauri-drag-region className="h-6 flex-1" />}
          <div className="flex items-center gap-1.5 text-xs text-gray-500 select-none">
            <Clock className="w-3 h-3" aria-hidden="true" />
            <span>Updated {formatLastUpdate(lastDataAt)}</span>
          </div>
          <button
            type="button"
            onClick={onRefresh}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs text-gray-400 hover:text-cyan-400 hover:bg-cyan-500/5 transition-all no-drag focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/60"
            title="Refresh now"
          >
            <RefreshCw className="w-3 h-3" aria-hidden="true" />
            Refresh
          </button>
          {isDesktop && <div data-tauri-drag-region className="h-6 w-10" />}
        </div>
        <div className="p-6">{children}</div>
      </main>
    </div>
  );
}
