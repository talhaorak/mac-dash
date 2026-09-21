import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, RotateCcw, RotateCw, Search, Trash2, X } from "lucide-react";
import { Dialog } from "@/components/ui/Dialog";
import { GlowCard } from "@/components/ui/GlowCard";
import { ConfirmButton } from "@/components/ui/ConfirmButton";
import { toast } from "@/components/ui/Toast";
import { backend, type BackgroundItem, type LoginItem, type StartupExtras } from "@/lib/backend";
import { cn } from "@/lib/utils";
import { t, useT } from "@/i18n";

// ── Shared pieces (also used by PowerSchedulePanel) ──────────────────

export interface Loader<T> {
  data: T | null;
  /** Message of the last failed call. `data` keeps the last good value. */
  error: string | null;
  loading: boolean;
  load: () => Promise<void>;
}

/** Runs one backend call on request and keeps its result, its error and its loading flag. `fn` must be stable. */
export function useLoader<T>(fn: () => Promise<T>): Loader<T> {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: false });
  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await fn();
      setState({ data, error: null, loading: false });
    } catch (e) {
      setState((s) => ({ data: s.data, error: (e as Error).message || t("detail.common.requestFailed"), loading: false }));
    }
  }, [fn]);
  return { ...state, load };
}

export interface InlineErrorProps {
  /** What failed, as a sentence: "The power schedule could not be read." */
  title: string;
  /** Error text from the backend. */
  message: string;
  onRetry: () => void;
  retrying?: boolean;
  className?: string;
}

/** Error state of a panel. The panel stays usable and offers a retry. */
export function InlineError({ title, message, onRetry, retrying = false, className }: InlineErrorProps) {
  return (
    <div role="alert" className={cn("flex items-start gap-2.5 rounded-lg border border-red-500/20 bg-red-500/[0.06] px-3 py-2", className)}>
      <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0 text-red-400" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-red-300">{title}</p>
        <p className="text-[11px] text-gray-400 break-words">{message}</p>
      </div>
      <button
        type="button"
        disabled={retrying}
        onClick={onRetry}
        className="inline-flex items-center gap-1 flex-shrink-0 px-2.5 py-1 rounded-lg text-xs text-gray-200 bg-white/[0.06] hover:bg-white/[0.1] disabled:opacity-40 focus:outline-none focus-visible:ring-1 focus-visible:ring-cyan-500/50"
      >
        <RotateCw className={cn("w-3 h-3", retrying && "animate-spin")} aria-hidden />
        {retrying ? t("detail.common.retrying") : t("common.retry")}
      </button>
    </div>
  );
}

export interface CollapsibleCardProps {
  title: string;
  /** Short text on the right side of the header. */
  summary?: ReactNode;
  defaultOpen?: boolean;
  /** Runs on the first expansion. Use it to load the content lazily. */
  onFirstOpen?: () => void;
  children: ReactNode;
}

/** Card whose body renders only while it is expanded. */
export function CollapsibleCard({ title, summary, defaultOpen = false, onFirstOpen, children }: CollapsibleCardProps) {
  const bodyId = useId();
  const [open, setOpen] = useState(defaultOpen);
  const opened = useRef(false);

  useEffect(() => {
    if (!open || opened.current) return;
    opened.current = true;
    onFirstOpen?.();
  }, [open, onFirstOpen]);

  return (
    <GlowCard padding="sm">
      <h2>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen(!open)}
          className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-white/[0.03] transition-colors text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-cyan-500/50"
        >
          {open ? <ChevronDown className="w-4 h-4 text-gray-400" aria-hidden /> : <ChevronRight className="w-4 h-4 text-gray-500" aria-hidden />}
          <span className="text-sm font-semibold text-gray-300">{title}</span>
          {summary && <span className="ml-auto text-xs font-normal text-gray-600">{summary}</span>}
        </button>
      </h2>
      <div id={bodyId} hidden={!open}>
        {open && children}
      </div>
    </GlowCard>
  );
}

// ── Startup mechanisms that are not launchd plists ───────────────────

const loadExtras = () => backend.getStartupExtras();
const loadLoginItems = () => backend.getLoginItems();
const loadBackgroundItems = () => backend.getBackgroundItems();

/** cron, helper tools, legacy startup items, login items and the Background Task Management records. */
export function StartupExtrasCard() {
  useT(); // subscribe: re-render when the language changes
  const extras = useLoader<StartupExtras>(loadExtras);
  const background = useLoader<BackgroundItem[]>(loadBackgroundItems);

  const loadAll = useCallback(() => {
    void extras.load();
    void background.load();
  }, [extras.load, background.load]);

  const e = extras.data;
  const hasExtras = !(extras.error && !e);

  return (
    <CollapsibleCard title={t("detail.startup.title")} summary={t("detail.startup.summary")} onFirstOpen={loadAll}>
      <div className="p-2 space-y-4">
        {extras.error && (
          <InlineError title={t("detail.startup.extrasError")} message={extras.error} onRetry={extras.load} retrying={extras.loading} />
        )}
        <div className="grid gap-4 md:grid-cols-2">
          {hasExtras && (
            <ExtrasGroup title={t("detail.startup.cronTitle")} hint={t("detail.startup.cronHint")} rows={e?.cron.map((line) => ({ main: line })) ?? null} />
          )}
          {hasExtras && <HelperToolsSection tools={e?.helperTools ?? null} onChanged={extras.load} />}
          {hasExtras && (
            <ExtrasGroup
              title={t("detail.startup.legacyTitle")}
              hint={t("detail.startup.legacyHint")}
              rows={e?.startupItems.map((h) => ({ main: h.name, sub: h.path })) ?? null}
            />
          )}
          <LoginItemsSection />
        </div>
        <BackgroundItemsSection loader={background} />
      </div>
    </CollapsibleCard>
  );
}

function ExtrasGroup({ title, hint, rows }: { title: string; hint: string; rows: { main: string; sub?: string }[] | null }) {
  return (
    <div className="space-y-1.5 min-w-0">
      <h3 className="text-xs font-semibold text-gray-400">
        {title} {rows && <span className="text-gray-600 font-normal">({rows.length})</span>}
      </h3>
      <p className="text-[11px] text-gray-600">{hint}</p>
      {rows === null ? (
        <p className="text-[11px] text-gray-600">{t("common.loading")}</p>
      ) : rows.length === 0 ? (
        <p className="text-[11px] text-gray-600">{t("detail.startup.none")}</p>
      ) : (
        <ul className="space-y-0.5">
          {rows.map((r, i) => (
            <li key={i} className="text-xs font-mono text-gray-300 truncate" title={r.sub ?? r.main}>
              {r.main}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Privileged helper tools ──────────────────────────────────────────

/** The backend answers with exactly this text when the Trash copy is not possible. The user must agree to the permanent delete. */
const NEEDS_PERMANENT_DELETE = "The file cannot be copied to the Trash. Delete it permanently?";

const rowDeleteButton =
  "flex-shrink-0 inline-flex items-center gap-1 p-1.5 rounded-lg text-[11px] text-gray-500 hover:text-red-400 hover:bg-red-500/10 disabled:opacity-40 focus:outline-none focus-visible:ring-1 focus-visible:ring-red-500/50";

function HelperToolsSection({ tools, onChanged }: { tools: StartupExtras["helperTools"] | null; onChanged: () => void }) {
  const titleId = useId();
  const textId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  /** The last failed delete. Retry runs the same delete again. */
  const [failure, setFailure] = useState<{ name: string; permanent: boolean; message: string } | null>(null);
  /** The tool that waits for the explicit "delete permanently" answer. */
  const [askPermanent, setAskPermanent] = useState<string | null>(null);
  // The dialog text stays while the close animation runs.
  const [lastAsked, setLastAsked] = useState("");

  const remove = async (name: string, permanent: boolean) => {
    setDeleting(name);
    setFailure(null);
    try {
      await backend.deleteHelperTool(name, permanent);
      toast.success(permanent ? t("detail.startup.helperDeletedPermanent", { name }) : t("detail.startup.helperMovedToTrash", { name }));
      onChanged();
    } catch (e) {
      const message = (e as Error).message || t("detail.common.requestFailed");
      if (!permanent && message === NEEDS_PERMANENT_DELETE) {
        setLastAsked(name);
        setAskPermanent(name);
      } else {
        setFailure({ name, permanent, message });
      }
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="space-y-1.5 min-w-0">
      <h3 className="text-xs font-semibold text-gray-400">
        {t("detail.startup.helperToolsTitle", { count: tools?.length ?? 0 })}
      </h3>
      <p className="text-[11px] text-gray-600">{t("detail.startup.helperToolsHint")}</p>

      {failure && (
        <InlineError
          title={t("detail.startup.helperDeleteErrorTitle", { name: failure.name })}
          message={failure.message}
          onRetry={() => remove(failure.name, failure.permanent)}
          retrying={deleting === failure.name}
        />
      )}

      {tools === null ? (
        <p className="text-[11px] text-gray-600">{t("common.loading")}</p>
      ) : tools.length === 0 ? (
        <p className="text-[11px] text-gray-600">{t("detail.startup.none")}</p>
      ) : (
        <ul className="space-y-0.5">
          {tools.map((tool) => (
            <li key={tool.path} className="flex items-center gap-2 min-w-0 rounded-lg hover:bg-white/[0.03] pl-1">
              <div className="min-w-0 flex-1 text-xs font-mono text-gray-300 truncate" title={tool.path}>
                {tool.name}
              </div>
              <ConfirmButton
                onConfirm={() => remove(tool.name, false)}
                disabled={deleting !== null}
                confirmLabel={t("detail.startup.confirmDeleteHelper")}
                title={t("detail.startup.deleteHelperTitle")}
                className={rowDeleteButton}
                armedClassName="bg-red-500/20 text-red-300! px-2"
              >
                <Trash2 className="w-3 h-3" aria-hidden />
                <span className="sr-only">
                  {deleting === tool.name ? t("detail.startup.deletingHelper", { name: tool.name }) : t("detail.startup.deleteHelperSr", { name: tool.name })}
                </span>
              </ConfirmButton>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={askPermanent !== null} onClose={() => setAskPermanent(null)} labelledBy={titleId} describedBy={textId} initialFocusRef={cancelRef} className="max-w-md!">
        <div className="p-6 space-y-4">
          <h2 id={titleId} className="text-lg font-bold text-white">
            {t("detail.startup.deletePermTitle")}
          </h2>
          <p id={textId} className="text-sm text-gray-300">
            {t("detail.startup.cannotCopy", { path: lastAsked })}
          </p>
          <div className="flex justify-end gap-2">
            <button
              ref={cancelRef}
              type="button"
              onClick={() => setAskPermanent(null)}
              className="px-3 py-2 rounded-xl text-xs text-gray-300 bg-white/[0.04] hover:bg-white/[0.08] focus:outline-none focus-visible:ring-1 focus-visible:ring-cyan-500/50"
            >
              {t("detail.startup.keepTool")}
            </button>
            <button
              type="button"
              onClick={() => {
                const name = askPermanent;
                setAskPermanent(null);
                if (name) void remove(name, true);
              }}
              className="px-3 py-2 rounded-xl text-xs font-semibold text-red-100 bg-red-500/30 hover:bg-red-500/40 border border-red-500/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60"
            >
              {t("detail.startup.deletePermButton")}
            </button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

// ── Login items ──────────────────────────────────────────────────────

function LoginItemsSection() {
  const items = useLoader<LoginItem[]>(loadLoginItems);
  const [deleting, setDeleting] = useState<string | null>(null);

  const remove = async (item: LoginItem) => {
    setDeleting(item.name);
    try {
      await backend.deleteLoginItem(item.name);
      toast.success(t("detail.startup.loginItemRemoved", { name: item.name }));
    } catch (e) {
      toast.error(`${item.name}: ${(e as Error).message}`);
    } finally {
      setDeleting(null);
      void items.load();
    }
  };

  return (
    <div className="space-y-1.5 min-w-0">
      <h3 className="text-xs font-semibold text-gray-400">
        {t("detail.startup.loginItemsTitle", { count: items.data?.length ?? 0 })}
      </h3>
      <p className="text-[11px] text-gray-600">{t("detail.startup.loginItemsHint")}</p>

      {items.error && <InlineError title={t("detail.startup.loginItemsError")} message={items.error} onRetry={items.load} retrying={items.loading} />}

      {items.data === null ? (
        !items.error && (
          <button
            type="button"
            disabled={items.loading}
            onClick={items.load}
            className="px-2.5 py-1 rounded-lg text-xs bg-white/[0.06] text-gray-300 hover:bg-white/[0.1] disabled:opacity-40 focus:outline-none focus-visible:ring-1 focus-visible:ring-cyan-500/50"
          >
            {items.loading ? t("detail.startup.reading") : t("detail.startup.readLoginItems")}
          </button>
        )
      ) : items.data.length === 0 ? (
        <p className="text-[11px] text-gray-600">{t("detail.startup.none")}</p>
      ) : (
        <ul className="space-y-0.5">
          {items.data.map((item) => (
            <li key={`${item.name}\n${item.path}`} className="flex items-center gap-2 min-w-0 rounded-lg hover:bg-white/[0.03] pl-1">
              <div className="min-w-0 flex-1">
                <div className="text-xs font-mono text-gray-300 truncate">
                  {item.name}
                  {item.hidden && (
                    <span className="ml-1.5 px-1.5 py-px rounded text-[9px] font-sans font-medium bg-white/[0.06] text-gray-400">
                      {t("detail.startup.hiddenBadge")}
                    </span>
                  )}
                </div>
                <div className="text-[10px] font-mono text-gray-600 truncate" title={item.path}>
                  {item.path}
                </div>
              </div>
              <ConfirmButton
                onConfirm={() => remove(item)}
                disabled={deleting !== null}
                confirmLabel={t("detail.startup.confirmRemoveLoginItem")}
                title={t("detail.startup.removeLoginItemTitle")}
                className="flex-shrink-0 inline-flex items-center gap-1 p-1.5 rounded-lg text-[11px] text-gray-500 hover:text-red-400 hover:bg-red-500/10 disabled:opacity-40 focus:outline-none focus-visible:ring-1 focus-visible:ring-red-500/50"
                armedClassName="bg-red-500/20 text-red-300! px-2"
              >
                <Trash2 className="w-3 h-3" aria-hidden />
                <span className="sr-only">{t("detail.startup.removeLoginItemSr", { name: item.name })}</span>
              </ConfirmButton>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Background items (Background Task Management) ────────────────────

const BACKGROUND_WINDOW = 100;

const DISPOSITION_TONE: Record<string, string> = {
  enabled: "bg-green-500/15 text-green-400",
  disabled: "bg-amber-500/15 text-amber-400",
  allowed: "bg-cyan-500/15 text-cyan-400",
  disallowed: "bg-red-500/15 text-red-400",
};

function BackgroundItemsSection({ loader }: { loader: Loader<BackgroundItem[]> }) {
  const [search, setSearch] = useState("");
  const [onlyEnabled, setOnlyEnabled] = useState(false);
  const [limit, setLimit] = useState(BACKGROUND_WINDOW);
  const [resetOpen, setResetOpen] = useState(false);

  const all = loader.data;
  const filtered = useMemo(() => {
    if (!all) return [];
    const tokens = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return all
      .filter((item) => {
        if (onlyEnabled && !item.disposition.includes("enabled")) return false;
        if (tokens.length === 0) return true;
        const haystack = [item.name, item.developerName, item.type, item.identifier, item.executablePath, item.url, item.teamIdentifier]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return tokens.every((t) => haystack.includes(t));
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [all, search, onlyEnabled]);

  const visible = filtered.slice(0, limit);

  return (
    <section aria-label={t("detail.startup.backgroundItemsAria")} className="space-y-2 border-t border-white/[0.06] pt-3">
      <div className="flex items-center gap-2 flex-wrap">
        <h3 className="text-xs font-semibold text-gray-400">
          {all &&
            (filtered.length === all.length
              ? t("detail.startup.backgroundItemsTitle", { count: all.length })
              : t("detail.startup.backgroundItemsFiltered", { shown: filtered.length, total: all.length }))}
        </h3>
        <div className="ml-auto flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500" aria-hidden />
            <input
              type="search"
              aria-label={t("detail.startup.searchAria")}
              placeholder={t("detail.startup.searchPlaceholder")}
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setLimit(BACKGROUND_WINDOW);
              }}
              className="w-56 pl-8 pr-3 py-1 rounded-lg bg-white/[0.04] border border-white/[0.06] text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/20"
            />
          </div>
          <button
            type="button"
            aria-pressed={onlyEnabled}
            onClick={() => setOnlyEnabled(!onlyEnabled)}
            className={cn(
              "px-2.5 py-1 rounded-lg text-xs font-medium transition-all focus:outline-none focus-visible:ring-1 focus-visible:ring-cyan-500/50",
              onlyEnabled ? "bg-cyan-500/15 text-cyan-400 ring-1 ring-cyan-500/30" : "text-gray-500 hover:text-gray-300 hover:bg-white/[0.04]"
            )}
          >
            {t("detail.startup.onlyEnabled")}
          </button>
          <button
            type="button"
            aria-haspopup="dialog"
            onClick={() => setResetOpen(true)}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium text-gray-500 hover:text-red-400 hover:bg-red-500/10 focus:outline-none focus-visible:ring-1 focus-visible:ring-red-500/50"
          >
            <RotateCcw className="w-3 h-3" aria-hidden />
            {t("detail.startup.resetEllipsis")}
          </button>
        </div>
      </div>
      <p className="text-[11px] text-gray-600">{t("detail.startup.backgroundItemsHint")}</p>
      <ResetBackgroundItemsDialog open={resetOpen} onClose={() => setResetOpen(false)} onDone={loader.load} />

      {loader.error && <InlineError title={t("detail.startup.backgroundItemsError")} message={loader.error} onRetry={loader.load} retrying={loader.loading} />}

      {all === null ? (
        !loader.error && <p className="text-[11px] text-gray-600">{loader.loading ? t("detail.startup.readingBackground") : t("detail.common.notLoaded")}</p>
      ) : filtered.length === 0 ? (
        <p className="text-[11px] text-gray-600">{all.length === 0 ? t("detail.startup.noBackgroundItems") : t("detail.startup.noBackgroundMatch")}</p>
      ) : (
        <>
          <ul className="grid gap-1.5 lg:grid-cols-2">
            {visible.map((item, i) => (
              <li key={`${item.uid}:${item.identifier ?? item.name}:${i}`} className="min-w-0 rounded-lg border border-white/[0.04] bg-black/20 px-3 py-2 space-y-1">
                <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                  <span className="text-xs font-medium text-gray-200 truncate">{item.name}</span>
                  <span className="px-1.5 py-px rounded text-[9px] font-medium bg-purple-500/15 text-purple-300">{item.type}</span>
                  {item.disposition.map((d) => (
                    <span key={d} className={cn("px-1.5 py-px rounded text-[9px] font-medium", DISPOSITION_TONE[d] ?? "bg-white/[0.06] text-gray-400")}>
                      {d}
                    </span>
                  ))}
                </div>
                <dl className="text-[10px] text-gray-500 space-y-px">
                  <BackgroundFact term={t("detail.startup.factDeveloper")} value={item.developerName} mono={false} />
                  <BackgroundFact term={t("detail.startup.factIdentifier")} value={item.identifier} />
                  <BackgroundFact term={t("detail.startup.factExecutable")} value={item.executablePath} />
                  <BackgroundFact term={t("detail.startup.factTeam")} value={item.teamIdentifier} />
                  <BackgroundFact term={t("detail.startup.factUser")} value={item.uid === 0 ? "root (uid 0)" : `uid ${item.uid}`} mono={false} />
                </dl>
              </li>
            ))}
          </ul>
          {filtered.length > visible.length && (
            <button
              type="button"
              onClick={() => setLimit((n) => n + BACKGROUND_WINDOW)}
              className="w-full py-2 text-xs text-cyan-400 hover:bg-white/[0.03] rounded-lg focus:outline-none focus-visible:ring-1 focus-visible:ring-cyan-500/50"
            >
              {t("detail.startup.showMore", { count: Math.min(BACKGROUND_WINDOW, filtered.length - visible.length) })}
            </button>
          )}
        </>
      )}
    </section>
  );
}

const RESET_WORD = "RESET";

/** Last question before `sfltool resetbtm`. The final button stays off until the user types the word. */
function ResetBackgroundItemsDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const titleId = useId();
  const textId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <Dialog open={open} onClose={onClose} labelledBy={titleId} describedBy={textId} initialFocusRef={inputRef} closeOnBackdrop={false} className="max-w-lg!">
      {/* The dialog mounts its children on open, so every open starts with an empty field. */}
      <ResetBody titleId={titleId} textId={textId} inputRef={inputRef} onClose={onClose} onDone={onDone} />
    </Dialog>
  );
}

function ResetBody({
  titleId,
  textId,
  inputRef,
  onClose,
  onDone,
}: {
  titleId: string;
  textId: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onClose: () => void;
  onDone: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const armed = typed.trim() === RESET_WORD;

  const run = async () => {
    if (!armed || running) return;
    setRunning(true);
    setError(null);
    try {
      await backend.resetBackgroundItems();
      toast.success(t("detail.startup.resetSuccess"));
      onDone();
      onClose();
    } catch (e) {
      setError((e as Error).message || t("detail.common.requestFailed"));
    } finally {
      setRunning(false);
    }
  };

  return (
    <form
      className="p-6 space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void run();
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <h2 id={titleId} className="text-lg font-bold text-white">
          {t("detail.startup.resetTitle")}
        </h2>
        <button type="button" aria-label={t("common.close")} onClick={onClose} className="p-2 rounded-lg hover:bg-white/[0.06] text-gray-400 focus:outline-none focus-visible:ring-1 focus-visible:ring-cyan-500/50">
          <X className="w-4 h-4" aria-hidden />
        </button>
      </div>

      <div id={textId} className="space-y-2 text-sm text-gray-300">
        <p className="flex gap-2 rounded-xl border border-red-500/20 bg-red-500/[0.06] p-3 text-xs text-red-200/90">
          <AlertTriangle className="w-4 h-4 flex-shrink-0 text-red-400" aria-hidden />
          <span>
            <span className="font-semibold">{t("common.warning")}: </span>
            {t("detail.startup.resetWarningBody")}
          </span>
        </p>
        <p>{t("detail.startup.resetExplanation1")}</p>
        <p>{t("detail.startup.resetExplanation2")}</p>
      </div>

      <label className="block space-y-1">
        <span className="text-xs font-medium text-gray-400">{t("detail.startup.typeToContinue", { word: RESET_WORD })}</span>
        <input
          ref={inputRef}
          type="text"
          value={typed}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          disabled={running}
          onChange={(e) => setTyped(e.target.value)}
          className="w-full px-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.08] text-sm font-mono text-gray-200 placeholder-gray-600 focus:outline-none focus:border-red-500/50 focus:ring-1 focus:ring-red-500/20 disabled:opacity-50"
        />
      </label>

      {error && <InlineError title={t("detail.startup.resetError")} message={error} onRetry={run} retrying={running} />}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="px-3 py-2 rounded-xl text-xs text-gray-300 bg-white/[0.04] hover:bg-white/[0.08] focus:outline-none focus-visible:ring-1 focus-visible:ring-cyan-500/50"
        >
          {t("common.cancel")}
        </button>
        <button
          type="submit"
          disabled={!armed || running}
          className="px-3 py-2 rounded-xl text-xs font-semibold text-red-100 bg-red-500/30 hover:bg-red-500/40 border border-red-500/40 disabled:opacity-40 disabled:hover:bg-red-500/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60"
        >
          {running ? t("detail.startup.resetting") : t("detail.startup.resetSubmit")}
        </button>
      </div>
    </form>
  );
}

function BackgroundFact({ term, value, mono = true }: { term: string; value: string | null; mono?: boolean }) {
  if (!value) return null;
  return (
    <div className="flex gap-1.5 min-w-0">
      <dt className="flex-shrink-0 w-16 text-gray-600">{term}</dt>
      <dd className={cn("min-w-0 truncate text-gray-400", mono && "font-mono")} title={value}>
        {value}
      </dd>
    </div>
  );
}
