import { useState, useEffect, useRef, type ReactNode } from "react";
import { Sidebar } from "./Sidebar";
import { QuickSwitcher, quickSwitcherShortcut } from "@/components/jobs/QuickSwitcher";
import { useNavStore, useConnectionStore } from "@/stores/app";
import { cn } from "@/lib/utils";
import { RefreshCw, Clock, Search } from "lucide-react";
import { backend } from "@/lib/backend";
import { useWindowDrag } from "@/lib/window-drag";
import { ThemeToggle } from "@/components/ThemeToggle";
import { LANGUAGES, formatAgo, t, useLanguageChoice, setLocale, type LanguageChoice } from "@/i18n";

interface ShellProps {
  children: ReactNode;
  version: string | null;
  onRefresh: () => void;
}

function formatLastUpdate(ts: number | null): string {
  if (!ts) return t("time.never");
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 3) return t("time.justNow");
  return formatAgo(ts);
}

export function Shell({ children, version, onRefresh }: ShellProps) {
  // Subscribes to language changes, so every t() call below re-renders with the new language.
  const languageChoice = useLanguageChoice();
  const sidebarCollapsed = useNavStore((s) => s.sidebarCollapsed);
  const lastDataAt = useConnectionStore((s) => s.lastDataAt);
  const [, setTick] = useState(0);
  const onDrag = useWindowDrag();
  const isDesktop = backend.isDesktop();
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const switcherOpenRef = useRef(switcherOpen);
  switcherOpenRef.current = switcherOpen;

  // Cmd+K or Ctrl+K opens the "Go to" dialog from every page.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "k" || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      e.preventDefault();
      if (switcherOpenRef.current) {
        setSwitcherOpen(false);
        return;
      }
      // Another modal may hold unsaved edits (the job editor). A jump to another page would drop them.
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      setSwitcherOpen(true);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

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
          <button
            type="button"
            onClick={() => setSwitcherOpen(true)}
            aria-haspopup="dialog"
            aria-keyshortcuts="Meta+K Control+K"
            title={t("shell.goToTitle")}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs text-gray-400 bg-white/[0.04] border border-white/[0.06] hover:text-cyan-400 hover:bg-cyan-500/5 transition-all no-drag focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/60"
          >
            <Search className="w-3 h-3" aria-hidden="true" />
            {t("shell.goTo")}
            <kbd className="ml-1 font-sans text-[10px] text-gray-600">{quickSwitcherShortcut()}</kbd>
          </button>
          {isDesktop && <div data-tauri-drag-region className="h-6 flex-1" />}
          <div className="flex items-center gap-1.5 text-xs text-gray-500 select-none">
            <Clock className="w-3 h-3" aria-hidden="true" />
            <span>{t("shell.updated", { when: formatLastUpdate(lastDataAt) })}</span>
          </div>
          <button
            type="button"
            onClick={onRefresh}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs text-gray-400 hover:text-cyan-400 hover:bg-cyan-500/5 transition-all no-drag focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/60"
            title={t("shell.refreshNow")}
          >
            <RefreshCw className="w-3 h-3" aria-hidden="true" />
            {t("common.refresh")}
          </button>
          <div className="no-drag flex items-center gap-1.5">
            <select
              aria-label={t("lang.label")}
              value={languageChoice}
              onChange={(e) => setLocale(e.target.value as LanguageChoice)}
              className="text-xs rounded-lg bg-white/[0.04] border border-white/[0.06] text-gray-400 px-2 py-1.5 hover:text-gray-200 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/60"
            >
              <option value="system">{t("lang.system")}</option>
              {LANGUAGES.map((language) => (
                <option key={language.id} value={language.id}>
                  {language.name}
                </option>
              ))}
            </select>
            <ThemeToggle />
          </div>
          {isDesktop && <div data-tauri-drag-region className="h-6 w-10" />}
        </div>
        <div className="p-6">{children}</div>
      </main>
      <QuickSwitcher open={switcherOpen} onClose={() => setSwitcherOpen(false)} />
    </div>
  );
}
