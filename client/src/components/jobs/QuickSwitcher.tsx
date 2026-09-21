import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Activity, Cog, CornerDownLeft, LayoutDashboard, Puzzle, ScrollText, Search, type LucideIcon } from "lucide-react";
import { Dialog } from "@/components/ui/Dialog";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { useNavStore, useServicesStore, type ServiceInfo } from "@/stores/app";
import { cn } from "@/lib/utils";
import { scopeFor } from "@shared/launchd";

const MAX_RESULTS = 50;

const PAGES: { id: string; title: string; icon: LucideIcon }[] = [
  { id: "dashboard", title: "Dashboard", icon: LayoutDashboard },
  { id: "services", title: "Services", icon: Cog },
  { id: "processes", title: "Processes", icon: Activity },
  { id: "logs", title: "Logs", icon: ScrollText },
  { id: "plugins", title: "Plugins", icon: Puzzle },
];

type Result = { kind: "page"; id: string; title: string; icon: LucideIcon } | { kind: "job"; service: ServiceInfo };

/** Text of the keyboard shortcut for the current platform: "⌘K" on a Mac, "Ctrl K" elsewhere. */
export function quickSwitcherShortcut(): string {
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  return mac ? "⌘K" : "Ctrl K";
}

/** Lower score is a better match. `null` means that a token is missing from the label and the program. */
function scoreJob(label: string, haystack: string, query: string, tokens: string[]): number | null {
  if (!tokens.every((t) => haystack.includes(t))) return null;
  if (label === query) return 0;
  if (label.startsWith(query)) return 1;
  // "com.example.backup" is found by "backup": the last part of a label is its name.
  if (label.slice(label.lastIndexOf(".") + 1).startsWith(tokens[0])) return 2;
  if (tokens.every((t) => label.includes(t))) return 3;
  return 4;
}

export interface QuickSwitcherProps {
  open: boolean;
  onClose: () => void;
}

/**
 * "Go to" dialog. It lists the pages and the launchd jobs that contain every word of the query.
 * Arrow keys move the selection and Enter opens it. A job opens its detail drawer on the Services page.
 */
export function QuickSwitcher({ open, onClose }: QuickSwitcherProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <Dialog open={open} onClose={onClose} ariaLabel="Go to a page or a job" initialFocusRef={inputRef} className="h-[28rem] flex flex-col overflow-hidden!">
      {/* The dialog mounts its children on open, so every open starts with an empty query. */}
      <SwitcherBody inputRef={inputRef} onClose={onClose} />
    </Dialog>
  );
}

function SwitcherBody({ inputRef, onClose }: { inputRef: React.RefObject<HTMLInputElement | null>; onClose: () => void }) {
  const listId = useId();
  const services = useServicesStore((s) => s.services);
  const setPage = useNavStore((s) => s.setPage);
  const navigateToService = useNavStore((s) => s.navigateToService);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const indexed = useMemo(
    () => services.map((service) => ({ service, label: service.label.toLowerCase(), haystack: `${service.label} ${service.program ?? ""}`.toLowerCase() })),
    [services]
  );

  const results = useMemo<Result[]>(() => {
    const q = query.trim().toLowerCase();
    const tokens = q.split(/\s+/).filter(Boolean);
    const pages: Result[] = PAGES.filter((p) => tokens.every((t) => p.title.toLowerCase().includes(t))).map((p) => ({ kind: "page", ...p }));
    const room = MAX_RESULTS - pages.length;
    if (tokens.length === 0) return [...pages, ...indexed.slice(0, room).map(({ service }): Result => ({ kind: "job", service }))];

    const jobs = indexed
      .flatMap((entry) => {
        const score = scoreJob(entry.label, entry.haystack, q, tokens);
        return score === null ? [] : [{ score, entry }];
      })
      .sort((a, b) => a.score - b.score || a.entry.label.length - b.entry.label.length || a.entry.label.localeCompare(b.entry.label))
      .slice(0, room)
      .map(({ entry }): Result => ({ kind: "job", service: entry.service }));
    return [...pages, ...jobs];
  }, [indexed, query]);

  // The job list refreshes in the background: keep the selection inside the list.
  const activeIndex = Math.min(active, Math.max(0, results.length - 1));
  const optionId = (i: number) => `${listId}-option-${i}`;

  useEffect(() => {
    document.getElementById(`${listId}-option-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [listId, activeIndex]);

  const choose = (result: Result | undefined) => {
    if (!result) return;
    if (result.kind === "page") setPage(result.id);
    else navigateToService(result.service.label, result.service.category);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (results.length === 0) return;
      setActive((activeIndex + (e.key === "ArrowDown" ? 1 : -1) + results.length) % results.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(results[activeIndex]);
    }
  };

  const firstJob = results.findIndex((r) => r.kind === "job");
  const pageResults = firstJob === -1 ? results : results.slice(0, firstJob);
  const jobResults = firstJob === -1 ? [] : results.slice(firstJob);

  const option = (result: Result, i: number) => {
    const selected = i === activeIndex;
    return (
      <div
        key={result.kind === "page" ? `page:${result.id}` : `job:${result.service.category}/${result.service.label}`}
        id={optionId(i)}
        role="option"
        aria-selected={selected}
        onMouseMove={() => !selected && setActive(i)}
        onClick={() => choose(result)}
        className={cn("flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer", selected ? "bg-cyan-500/15 ring-1 ring-cyan-500/30" : "hover:bg-white/[0.03]")}
      >
        {result.kind === "page" ? (
          <>
            <result.icon className="w-4 h-4 flex-shrink-0 text-gray-400" aria-hidden />
            <span className="text-sm text-gray-200">{result.title}</span>
            <span className="ml-auto text-[10px] text-gray-600">Page</span>
          </>
        ) : (
          <>
            <StatusBadge status={result.service.status} label="" size="sm" />
            <div className="min-w-0 flex-1">
              <div className="text-[12px] font-mono text-gray-200 truncate">{result.service.label}</div>
              {result.service.program && <div className="text-[10px] text-gray-600 truncate">{result.service.program}</div>}
            </div>
            <span className="flex-shrink-0 text-[10px] text-gray-600">
              {scopeFor(result.service.category)?.title} · {result.service.disabled ? "disabled" : result.service.status}
            </span>
          </>
        )}
        {selected && <CornerDownLeft className="w-3 h-3 flex-shrink-0 text-cyan-400" aria-hidden />}
      </div>
    );
  };

  return (
    <>
      <div className="relative flex-shrink-0 border-b border-white/[0.06]">
        <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" aria-hidden />
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-label="Go to a page or a job"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={results.length > 0 ? optionId(activeIndex) : undefined}
          autoComplete="off"
          spellCheck={false}
          placeholder="Go to a page or a launchd job…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          className="w-full pl-11 pr-4 py-3.5 bg-transparent text-sm text-gray-100 placeholder-gray-600 focus:outline-none"
        />
      </div>

      <div id={listId} role="listbox" aria-label="Results" className="flex-1 overflow-y-auto p-2">
        {results.length === 0 && <p className="px-3 py-6 text-sm text-gray-500 text-center">Nothing matches "{query.trim()}".</p>}
        {pageResults.length > 0 && (
          <div role="group" aria-label="Pages">
            <div aria-hidden className="px-3 pt-1 pb-1 text-[10px] font-medium uppercase tracking-wide text-gray-600">
              Pages
            </div>
            {pageResults.map((r, i) => option(r, i))}
          </div>
        )}
        {jobResults.length > 0 && (
          <div role="group" aria-label="Jobs">
            <div aria-hidden className="px-3 pt-3 pb-1 text-[10px] font-medium uppercase tracking-wide text-gray-600">
              Jobs
            </div>
            {jobResults.map((r, i) => option(r, pageResults.length + i))}
          </div>
        )}
      </div>

      <div className="flex-shrink-0 flex items-center gap-4 px-4 py-2 border-t border-white/[0.06] text-[10px] text-gray-600">
        <span>
          <kbd className="font-sans">↑</kbd> <kbd className="font-sans">↓</kbd> move
        </span>
        <span>
          <kbd className="font-sans">Enter</kbd> open
        </span>
        <span>
          <kbd className="font-sans">Esc</kbd> close
        </span>
        <span className="ml-auto" aria-live="polite">
          {results.length} {results.length === 1 ? "result" : "results"}
          {results.length === MAX_RESULTS && " (first 50)"}
        </span>
      </div>
    </>
  );
}
