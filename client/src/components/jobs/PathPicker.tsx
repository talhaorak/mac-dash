import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { AppWindow, CornerLeftUp, File, FileTerminal, Folder, FolderOpen, Loader2, RefreshCw, Search, X } from "lucide-react";
import { Dialog } from "@/components/ui/Dialog";
import { backend, type BrowseEntry, type BrowseResult } from "@/lib/backend";
import { cn } from "@/lib/utils";

// Folder browser for the path fields of the job form. A browser cannot return real file paths, and the desktop
// shell has no dialog plugin, so both builds list folders through `backend.browsePath`.
// The first half of this file is pure and unit-tested (helpers.test.ts).

/**
 * What the picker returns: a `file`, an `executable` file, an `app` bundle (the path of the .app),
 * a `folder`, or `any` (a file, or the folder that is open).
 */
export type PathPickerMode = "file" | "folder" | "executable" | "app" | "any";

export type EntryKind = "folder" | "app" | "executable" | "file";

export function entryKind(entry: BrowseEntry): EntryKind {
  if (entry.isApp) return "app";
  if (entry.isDirectory) return "folder";
  return entry.executable ? "executable" : "file";
}

export const ENTRY_KIND_LABELS: Record<EntryKind, string> = { folder: "Folder", app: "App", executable: "Executable", file: "File" };

/** Enter opens this entry as a folder. An app bundle is a folder too, except when the picker returns apps. */
export function canOpen(entry: BrowseEntry, mode: PathPickerMode): boolean {
  return entry.isDirectory && !(mode === "app" && entry.isApp);
}

/** Enter returns this entry. Folders are never picked from the list: "Choose this folder" returns the open one. */
export function canPick(entry: BrowseEntry, mode: PathPickerMode): boolean {
  switch (mode) {
    case "app":
      return entry.isApp;
    case "executable":
      return !entry.isDirectory && entry.executable;
    case "file":
    case "any":
      return !entry.isDirectory;
    case "folder":
      return false;
  }
}

export const picksOpenFolder = (mode: PathPickerMode) => mode === "folder" || mode === "any";

export function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

function trimSlashes(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

export function parentPath(path: string): string | null {
  const clean = trimSlashes(path);
  if (clean === "/" || !clean.startsWith("/")) return null;
  return clean.slice(0, clean.lastIndexOf("/")) || "/";
}

export function baseName(path: string): string {
  const clean = trimSlashes(path);
  return clean === "/" ? "" : clean.slice(clean.lastIndexOf("/") + 1);
}

export function breadcrumbs(path: string): { name: string; path: string }[] {
  const crumbs = [{ name: "/", path: "/" }];
  let at = "";
  for (const part of path.split("/").filter(Boolean)) {
    at += `/${part}`;
    crumbs.push({ name: part, path: at });
  }
  return crumbs;
}

/** The folder the picker opens for the current value of a field. "" is the home folder. */
export function startFolder(value: string | undefined, mode: PathPickerMode): string {
  const v = (value ?? "").trim();
  if (!v.startsWith("/")) return mode === "app" ? "/Applications" : "";
  if (mode === "folder") return trimSlashes(v);
  return parentPath(v) ?? "/";
}

export function visibleEntries(entries: BrowseEntry[], filter: string, showHidden: boolean): BrowseEntry[] {
  const q = filter.trim().toLowerCase();
  return entries.filter((e) => (showHidden || !e.hidden) && (q === "" || e.name.toLowerCase().includes(q)));
}

/** The backends are written at the same time as this file: never trust the shape. Throws on a wrong one. */
export function normalizeBrowseResult(raw: unknown): BrowseResult {
  const r = raw as Partial<BrowseResult> | null;
  if (!r || typeof r !== "object" || typeof r.path !== "string" || !r.path.startsWith("/") || !Array.isArray(r.entries)) {
    throw new Error("The backend returned an unexpected folder listing.");
  }
  const entries = r.entries
    .filter((e): e is BrowseEntry => !!e && typeof e === "object" && typeof (e as BrowseEntry).name === "string" && (e as BrowseEntry).name !== "")
    .map((e) => ({ name: e.name, isDirectory: e.isDirectory === true, isApp: e.isApp === true, executable: e.executable === true, hidden: e.hidden === true }));
  return { path: r.path, parent: typeof r.parent === "string" ? r.parent : parentPath(r.path), entries, truncated: r.truncated === true };
}

export function fileNameProblem(name: string): string | null {
  if (name.trim() === "") return "Enter a file name.";
  if (name.includes("/") || name.includes("\0")) return "A file name cannot contain a slash.";
  if (name === "." || name === "..") return "This is not a file name.";
  return null;
}

/** `path` is absolute, or relative to the home folder when `home` is true. */
export const PICKER_SHORTCUTS: { label: string; path: string; home?: boolean }[] = [
  { label: "Home", path: "", home: true },
  { label: "Applications", path: "/Applications" },
  { label: "/usr/local/bin", path: "/usr/local/bin" },
  { label: "/opt/homebrew/bin", path: "/opt/homebrew/bin" },
  { label: "LaunchAgents", path: "Library/LaunchAgents", home: true },
];

const MODE_TITLES: Record<PathPickerMode, string> = {
  file: "Choose a file",
  folder: "Choose a folder",
  executable: "Choose an executable",
  app: "Choose an app",
  any: "Choose a file or a folder",
};

const MODE_HINTS: Record<PathPickerMode, string> = {
  file: "Enter opens a folder or chooses a file.",
  folder: "Open the folder, then press “Choose this folder”.",
  executable: "Only files with an execute permission can be chosen.",
  app: "Enter opens a folder or chooses an app.",
  any: "Enter chooses a file. For a folder: open it, then press “Choose this folder”.",
};

// ── Component ────────────────────────────────────────────────────────

const HIDDEN_STORAGE_KEY = "macdash.pickerShowHidden";
const PAGE = 10;

function readShowHidden(): boolean {
  try {
    return window.localStorage.getItem(HIDDEN_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/** The home folder, learned from the first listing of "". */
let knownHome: string | null = null;

const KIND_ICONS: Record<EntryKind, typeof Folder> = { folder: Folder, app: AppWindow, executable: FileTerminal, file: File };

const pickerInput =
  "px-2.5 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.08] text-xs text-gray-200 placeholder-gray-600 " +
  "focus:outline-none focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/20 disabled:opacity-50";
const pickerButton =
  "inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-gray-300 bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] " +
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/50 disabled:opacity-40 disabled:hover:bg-white/[0.04]";
const primaryButton =
  "px-3 py-1.5 rounded-lg text-xs font-medium text-cyan-950 bg-cyan-400 hover:bg-cyan-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 disabled:opacity-40";

export interface PathPickerProps {
  open: boolean;
  mode: PathPickerMode;
  /** Current value of the field. The picker opens its folder. */
  value?: string;
  title?: string;
  /** `file` mode: also offer "use this folder + file name", for a file that does not exist yet (a log file). */
  allowNewFile?: boolean;
  suggestedName?: string;
  onPick: (path: string) => void;
  onClose: () => void;
}

export function PathPicker(props: PathPickerProps) {
  const titleId = useId();
  const filterRef = useRef<HTMLInputElement>(null);
  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      labelledBy={titleId}
      initialFocusRef={filterRef}
      className="max-w-2xl! h-[72vh] flex flex-col overflow-hidden p-0"
    >
      {props.open && <PickerBody {...props} titleId={titleId} filterRef={filterRef} />}
    </Dialog>
  );
}

function PickerBody({
  mode,
  value,
  title,
  allowNewFile,
  suggestedName,
  onPick,
  onClose,
  titleId,
  filterRef,
}: PathPickerProps & { titleId: string; filterRef: React.RefObject<HTMLInputElement | null> }) {
  const listId = useId();
  const nameId = useId();
  const [listing, setListing] = useState<BrowseResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ message: string; path: string } | null>(null);
  const [filter, setFilter] = useState("");
  const [showHidden, setShowHidden] = useState(readShowHidden);
  const [active, setActive] = useState(0);
  const [fileName, setFileName] = useState(() => (value && value.startsWith("/") && !value.endsWith("/") ? baseName(value) : "") || (suggestedName ?? ""));
  const request = useRef(0);

  /** `select` is the name of the entry to highlight, for example the folder the user came from. */
  const load = useCallback(async (path: string, options: { select?: string; fallbacks?: string[] } = {}) => {
    const token = ++request.current;
    setLoading(true);
    setError(null);
    let lastError: Error | null = null;
    for (const candidate of [path, ...(options.fallbacks ?? [])]) {
      try {
        const result = normalizeBrowseResult(await backend.browsePath(candidate));
        if (token !== request.current) return;
        if (candidate === "") knownHome = result.path;
        const shown = visibleEntries(result.entries, "", readShowHidden());
        setListing(result);
        setFilter("");
        setActive(Math.max(0, options.select ? shown.findIndex((e) => e.name === options.select) : 0));
        setLoading(false);
        return;
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
      }
    }
    if (token !== request.current) return;
    setError({ message: lastError?.message || "The folder could not be read.", path });
    setLoading(false);
  }, []);

  // Open the folder of the current value. A value that points nowhere falls back to its parent, then to home.
  useEffect(() => {
    const start = startFolder(value, mode);
    const fallbacks = start === "" ? [] : [...(parentPath(start) && parentPath(start) !== "/" ? [parentPath(start)!] : []), ""];
    load(start, { select: value ? baseName(value) : undefined, fallbacks });
    return () => {
      request.current++;
    };
    // Runs once per opening: the body is mounted while the dialog is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const entries = useMemo(() => (listing ? visibleEntries(listing.entries, filter, showHidden) : []), [listing, filter, showHidden]);
  const current = entries[Math.min(active, entries.length - 1)] as BrowseEntry | undefined;
  const activeIndex = current ? entries.indexOf(current) : -1;
  const optionId = (i: number) => `${listId}-o${i}`;

  useEffect(() => {
    if (activeIndex >= 0) document.getElementById(optionId(activeIndex))?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIndex, listing]);

  const goUp = () => {
    if (listing?.parent) load(listing.parent, { select: baseName(listing.path) });
  };

  const goShortcut = async (shortcut: (typeof PICKER_SHORTCUTS)[number]) => {
    if (!shortcut.home || shortcut.path === "") return load(shortcut.path);
    try {
      const home = knownHome ?? normalizeBrowseResult(await backend.browsePath("")).path;
      knownHome = home;
      load(joinPath(home, shortcut.path));
    } catch (e) {
      setError({ message: (e as Error).message || "The home folder could not be read.", path: "" });
    }
  };

  const activate = (entry: BrowseEntry | undefined) => {
    if (!entry || !listing) return;
    const path = joinPath(listing.path, entry.name);
    if (canPick(entry, mode)) onPick(path);
    else if (canOpen(entry, mode)) load(path);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const inFilter = e.target === filterRef.current;
    const last = entries.length - 1;
    const moveTo = (i: number) => {
      e.preventDefault();
      setActive(Math.min(Math.max(i, 0), Math.max(last, 0)));
    };
    if (e.key === "ArrowUp" && (e.metaKey || e.altKey)) {
      e.preventDefault();
      goUp();
    } else if (e.key === "ArrowDown") moveTo(activeIndex + 1);
    else if (e.key === "ArrowUp") moveTo(activeIndex - 1);
    else if (e.key === "PageDown") moveTo(activeIndex + PAGE);
    else if (e.key === "PageUp") moveTo(activeIndex - PAGE);
    else if (e.key === "Home" && !inFilter) moveTo(0);
    else if (e.key === "End" && !inFilter) moveTo(last);
    else if (e.key === "Enter") {
      e.preventDefault();
      activate(current);
    } else if (e.key === "Backspace" && (!inFilter || filter === "")) {
      e.preventDefault();
      goUp();
    }
  };

  const nameProblem = fileNameProblem(fileName);
  const canChooseCurrent = current !== undefined && canPick(current, mode);

  return (
    <>
      <div className="flex items-start gap-3 px-5 pt-4 pb-3 border-b border-white/[0.06]">
        <div className="flex-1 min-w-0">
          <h2 id={titleId} className="text-base font-bold text-white">
            {title ?? MODE_TITLES[mode]}
          </h2>
          <p className="text-[11px] text-gray-500">{MODE_HINTS[mode]} Backspace opens the parent folder.</p>
        </div>
        <button type="button" aria-label="Close the file browser" onClick={onClose} className="p-1.5 rounded-lg text-gray-400 hover:bg-white/[0.06]">
          <X className="w-4 h-4" aria-hidden />
        </button>
      </div>

      <div className="px-5 pt-3 space-y-2">
        <div role="group" aria-label="Places" className="flex flex-wrap gap-1">
          {PICKER_SHORTCUTS.map((s) => (
            <button key={s.label} type="button" onClick={() => goShortcut(s)} className={cn(pickerButton, "py-1", s.label.startsWith("/") && "font-mono")}>
              {s.label}
            </button>
          ))}
        </div>

        <nav aria-label="Folder path">
          <ol className="flex flex-wrap items-center gap-x-0.5 text-xs font-mono text-gray-400">
            {(listing ? breadcrumbs(listing.path) : []).map((crumb, i, all) => (
              <li key={crumb.path} className="flex items-center gap-0.5">
                {i > 1 && <span aria-hidden className="text-gray-600">/</span>}
                <button
                  type="button"
                  aria-current={i === all.length - 1 ? "location" : undefined}
                  onClick={() => load(crumb.path)}
                  className={cn(
                    "px-1 py-0.5 rounded hover:bg-white/[0.06] hover:text-gray-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/50",
                    i === all.length - 1 && "text-gray-200"
                  )}
                >
                  {crumb.name}
                </button>
              </li>
            ))}
          </ol>
        </nav>

        <div className="flex items-center gap-2">
          <button type="button" aria-label="Open the parent folder" title="Parent folder (Backspace)" disabled={!listing?.parent} onClick={goUp} className={pickerButton}>
            <CornerLeftUp className="w-3.5 h-3.5" aria-hidden />
          </button>
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-600" aria-hidden />
            <input
              ref={filterRef}
              type="text"
              role="combobox"
              aria-label="Filter this folder"
              aria-expanded
              aria-controls={listId}
              aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
              aria-autocomplete="list"
              placeholder="Filter this folder"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value);
                setActive(0);
              }}
              onKeyDown={onKeyDown}
              className={cn(pickerInput, "w-full pl-8")}
            />
          </div>
          <label className="flex items-center gap-1.5 text-xs text-gray-400 whitespace-nowrap">
            <input
              type="checkbox"
              checked={showHidden}
              onChange={(e) => {
                setShowHidden(e.target.checked);
                setActive(0);
                try {
                  window.localStorage.setItem(HIDDEN_STORAGE_KEY, e.target.checked ? "1" : "0");
                } catch {
                  // The choice lasts for this dialog only.
                }
              }}
              className="h-3.5 w-3.5 rounded accent-cyan-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/50"
            />
            Show hidden
          </label>
        </div>
      </div>

      <div className="flex-1 min-h-0 px-5 py-2">
        {error ? (
          <div role="alert" className="h-full flex flex-col items-center justify-center gap-2 text-center">
            <p className="text-sm text-red-400">{error.message}</p>
            {error.path !== "" && <p className="text-[11px] font-mono text-gray-600 break-all">{error.path}</p>}
            <button type="button" onClick={() => load(error.path)} className={pickerButton}>
              <RefreshCw className="w-3.5 h-3.5" aria-hidden />
              Retry
            </button>
          </div>
        ) : (
          <ul
            id={listId}
            role="listbox"
            tabIndex={0}
            aria-label={listing ? `Contents of ${listing.path}` : "Folder contents"}
            aria-busy={loading}
            aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
            onKeyDown={onKeyDown}
            className="h-full overflow-y-auto rounded-xl border border-white/[0.06] bg-black/20 p-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/40"
          >
            {loading && !listing ? (
              <li role="presentation" className="flex items-center justify-center gap-2 py-10 text-sm text-gray-500">
                <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> Reading the folder…
              </li>
            ) : entries.length === 0 ? (
              <li role="presentation" className="py-10 text-center text-sm text-gray-500">
                {listing && listing.entries.length > 0 ? "Nothing matches. Clear the filter, or show hidden files." : "This folder is empty."}
              </li>
            ) : (
              entries.map((entry, i) => {
                const kind = entryKind(entry);
                const Icon = kind === "folder" && i === activeIndex ? FolderOpen : KIND_ICONS[kind];
                const usable = canPick(entry, mode) || canOpen(entry, mode);
                return (
                  <li
                    key={entry.name}
                    id={optionId(i)}
                    role="option"
                    aria-selected={i === activeIndex}
                    aria-disabled={!usable}
                    onClick={() => setActive(i)}
                    onDoubleClick={() => activate(entry)}
                    className={cn(
                      "flex items-center gap-2 px-2 py-1 rounded-lg text-xs cursor-default select-none",
                      i === activeIndex ? "bg-cyan-500/15 text-cyan-200 ring-1 ring-cyan-500/30" : "text-gray-300 hover:bg-white/[0.04]",
                      !usable && "opacity-45",
                      loading && "opacity-60"
                    )}
                  >
                    <Icon className={cn("w-4 h-4 flex-shrink-0", kind === "folder" ? "text-cyan-400/80" : kind === "app" ? "text-purple-400" : kind === "executable" ? "text-green-400/80" : "text-gray-500")} aria-hidden />
                    <span className={cn("flex-1 min-w-0 truncate font-mono", entry.hidden && "italic")}>{entry.name}</span>
                    <span className="flex-shrink-0 text-[10px] text-gray-500">
                      {ENTRY_KIND_LABELS[kind]}
                      {entry.hidden ? ", hidden" : ""}
                    </span>
                  </li>
                );
              })
            )}
          </ul>
        )}
      </div>

      {listing?.truncated && !error && (
        <p className="px-5 pb-1 text-[11px] text-amber-400">This folder has more entries than the list can show. Type the path by hand when the entry is missing.</p>
      )}

      <div className="flex flex-wrap items-end gap-2 px-5 py-3 border-t border-white/[0.06]">
        {allowNewFile && (
          <div className="flex items-end gap-2 mr-auto">
            <label htmlFor={nameId} className="space-y-1">
              <span className="block text-[11px] text-gray-500">New file in this folder</span>
              <input
                id={nameId}
                type="text"
                spellCheck={false}
                value={fileName}
                placeholder="job.log"
                aria-invalid={fileName !== "" && nameProblem !== null}
                onChange={(e) => setFileName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" || !listing || nameProblem) return;
                  e.preventDefault();
                  onPick(joinPath(listing.path, fileName.trim()));
                }}
                className={cn(pickerInput, "w-52 font-mono")}
              />
            </label>
            <button
              type="button"
              disabled={!listing || nameProblem !== null || error !== null}
              title={fileName !== "" && nameProblem ? nameProblem : undefined}
              onClick={() => listing && onPick(joinPath(listing.path, fileName.trim()))}
              className={pickerButton}
            >
              Use this folder + file name
            </button>
          </div>
        )}
        <div className="ml-auto flex gap-2">
          <button type="button" onClick={onClose} className="px-3 py-1.5 rounded-lg text-xs text-gray-400 hover:bg-white/[0.06]">
            Cancel
          </button>
          {picksOpenFolder(mode) && (
            <button type="button" disabled={!listing || error !== null} onClick={() => listing && onPick(listing.path)} className={mode === "folder" ? primaryButton : pickerButton}>
              Choose this folder
            </button>
          )}
          {mode !== "folder" && (
            <button type="button" disabled={!canChooseCurrent || error !== null} onClick={() => activate(current)} className={primaryButton}>
              Choose{canChooseCurrent ? ` “${current!.name}”` : ""}
            </button>
          )}
        </div>
      </div>
    </>
  );
}

// ── Button for a form field ──────────────────────────────────────────

/** "Choose…" next to a path input. The dialog is mounted on the first click. */
export function ChoosePathButton({
  mode,
  value,
  onPick,
  disabled,
  fieldLabel,
  allowNewFile,
  suggestedName,
  className,
}: {
  mode: PathPickerMode;
  value?: string;
  onPick: (path: string) => void;
  disabled?: boolean;
  /** Name of the field, for the accessible name and the dialog title: "Choose Working directory". */
  fieldLabel: string;
  allowNewFile?: boolean;
  suggestedName?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  return (
    <>
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-label={`Choose: ${fieldLabel}`}
        onClick={() => {
          setMounted(true);
          setOpen(true);
        }}
        className={cn(
          "flex-shrink-0 self-start inline-flex items-center px-2 py-1.5 rounded-lg text-xs text-gray-400 border border-white/[0.08] hover:text-gray-200 hover:bg-white/[0.06] " +
            "focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/50 transition-colors disabled:opacity-40",
          className
        )}
      >
        Choose…
      </button>
      {mounted && (
        <PathPicker
          open={open}
          mode={mode}
          value={value}
          title={`${MODE_TITLES[mode]}: ${fieldLabel}`}
          allowNewFile={allowNewFile}
          suggestedName={suggestedName}
          onClose={() => setOpen(false)}
          onPick={(path) => {
            setOpen(false);
            onPick(path);
          }}
        />
      )}
    </>
  );
}
