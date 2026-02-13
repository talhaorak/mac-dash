import type { ReactNode } from "react";
import { Sidebar } from "./Sidebar";
import { useNavStore, useConnectionStore } from "@/stores/app";
import { cn } from "@/lib/utils";
import { RefreshCw, Clock } from "lucide-react";
import { useState, useEffect } from "react";
import { backend } from "@/lib/backend";

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
          backend.isDesktop() && "pt-7" // Extra padding for macOS traffic lights
        )}
      >
        {/* Top status bar */}
        <div className="sticky top-0 z-40 backdrop-blur-md bg-bg-primary/80 border-b border-white/[0.04] px-6 py-2 flex items-center justify-end gap-3">
          <div className="flex items-center gap-1.5 text-xs text-gray-500">
            <Clock className="w-3 h-3" />
            <span>Updated {formatLastUpdate(lastDataAt)}</span>
          </div>
          <button
            onClick={onRefresh}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs text-gray-400 hover:text-cyan-400 hover:bg-cyan-500/5 transition-all"
            title="Refresh now"
          >
            <RefreshCw className="w-3 h-3" />
            Refresh
          </button>
        </div>
        <div className="p-6">{children}</div>
      </main>
    </div>
  );
}
