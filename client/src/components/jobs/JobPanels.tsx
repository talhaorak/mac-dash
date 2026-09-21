import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { AlertOctagon, Bell, BellOff, FilePlus2, FileX2, FilePen, Trash2, X } from "lucide-react";
import { Dialog } from "@/components/ui/Dialog";
import { GlowCard } from "@/components/ui/GlowCard";
import { toast } from "@/components/ui/Toast";
import { backend, type JobEvent, type MonitorSettings } from "@/lib/backend";
import { useJobEventsStore, useNavStore, type ServiceInfo } from "@/stores/app";
import { servicesRoute, type RouteJobRef } from "@/lib/router";
import { cn } from "@/lib/utils";
import { explainExitStatus, formatInterval, nextRuns, scopeFor } from "@shared/launchd";
import { inputClass } from "./fields";
import { InlineError } from "./StartupPanels";

export type { MonitorSettings } from "@/lib/backend";
export { StartupExtrasCard } from "./StartupPanels";

// ── Monitor settings ─────────────────────────────────────────────────
// The backend owns the settings (~/.macdash/settings.json), so the native notifications honour them too.
// localStorage keeps a copy. The copy is the fallback while the backend call fails.

const SETTINGS_KEY = "macdash.jobMonitor";
/** Set after the value that an older version kept in localStorage reached the backend. */
const MIGRATED_KEY = "macdash.jobMonitor.migrated";
const SAVE_DELAY_MS = 500;
const MAX_PREFIXES = 50;
const MAX_PREFIX_LENGTH = 100;

function sanitizeSettings(input: unknown): MonitorSettings {
  const raw = (typeof input === "object" && input !== null ? input : {}) as { notify?: unknown; exclude?: unknown };
  const exclude = Array.isArray(raw.exclude)
    ? raw.exclude.filter((p): p is string => typeof p === "string" && p !== "").map((p) => p.slice(0, MAX_PREFIX_LENGTH)).slice(0, MAX_PREFIXES)
    : [];
  return { notify: raw.notify !== false, exclude };
}

function readLocalSettings(): MonitorSettings | null {
  try {
    const text = localStorage.getItem(SETTINGS_KEY);
    return text === null ? null : sanitizeSettings(JSON.parse(text));
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode or a full quota: the cache in memory still works for this session.
  }
}

/** Last known settings. `notifyJobEvent` reads them synchronously. */
let cachedSettings: MonitorSettings = readLocalSettings() ?? { notify: true, exclude: [] };

function remember(settings: MonitorSettings): void {
  cachedSettings = settings;
  writeLocal(SETTINGS_KEY, JSON.stringify(settings));
}

/** Settings from the last load or edit. Never waits for the backend. */
export function loadMonitorSettings(): MonitorSettings {
  return cachedSettings;
}

/**
 * Read the settings from the backend into the cache. Call it once at start and when the settings panel opens.
 * A value from an older version (localStorage only) moves to the backend once.
 * On failure the cache keeps the localStorage value and the error is thrown.
 */
export async function refreshMonitorSettings(): Promise<MonitorSettings> {
  const remote = sanitizeSettings(await backend.getMonitorSettings());
  const local = readLocalSettings();
  let migrated = true;
  try {
    migrated = localStorage.getItem(MIGRATED_KEY) === "1";
  } catch {
    // No localStorage: nothing to migrate.
  }
  if (!migrated) {
    if (local) await backend.setMonitorSettings(local);
    writeLocal(MIGRATED_KEY, "1");
    remember(local ?? remote);
  } else {
    remember(remote);
  }
  return cachedSettings;
}

const KIND = {
  added: { icon: FilePlus2, text: "Added", tone: "text-green-400" },
  modified: { icon: FilePen, text: "Changed", tone: "text-amber-400" },
  removed: { icon: FileX2, text: "Removed", tone: "text-red-400" },
  failed: { icon: AlertOctagon, text: "Failed", tone: "text-red-400" },
} as const;

/** "Failed (exit 78)" for a failed event, otherwise the plain kind text. */
function kindText(event: JobEvent): string {
  const text = KIND[event.kind].text;
  return event.kind === "failed" && event.exitStatus !== undefined ? `${text} (exit ${event.exitStatus})` : text;
}

/**
 * Show what a notification is about: `#/services?job=<category>/<label>`.
 * A removed job has no drawer to open, so its notification leads to the change history: `#/services?panel=changes`.
 * The browser notification and the desktop event "open-job" both end here.
 */
export function openJobFromNotification(job: RouteJobRef, kind?: JobEvent["kind"]): void {
  const route = kind === "removed" ? servicesRoute({ panel: "changes" }) : servicesRoute({ job: { label: job.label, category: job.category } });
  useNavStore.getState().navigate(route, "push");
}

/** Browser notification for a job change. Only fires while the dashboard is not in front. A click opens the job. */
export function notifyJobEvent(event: JobEvent): void {
  const settings = cachedSettings;
  if (!settings.notify || settings.exclude.some((p) => p && event.label.startsWith(p))) return;
  if (backend.isDesktop()) return; // the desktop shell posts native notifications itself
  if (typeof Notification === "undefined" || Notification.permission !== "granted" || !document.hidden) return;
  try {
    const notification = new Notification(`launchd job ${kindText(event).toLowerCase()}`, { body: `${event.label}\n${event.path}`, tag: event.id });
    notification.onclick = () => {
      window.focus();
      openJobFromNotification(event, event.kind);
      notification.close();
    };
  } catch {
    // Some browsers only allow notifications from a service worker. The toast and the badge still show the change.
  }
}

const parsePrefixes = (text: string) =>
  text
    .split(/[,\s]+/)
    .filter(Boolean)
    .map((p) => p.slice(0, MAX_PREFIX_LENGTH))
    .slice(0, MAX_PREFIXES);

export function JobEventsDrawer({ open, onClose, onOpenJob }: { open: boolean; onClose: () => void; onOpenJob: (event: JobEvent) => void }) {
  const titleId = useId();
  const events = useJobEventsStore((s) => s.events);
  const setEvents = useJobEventsStore((s) => s.setEvents);
  const markSeen = useJobEventsStore((s) => s.markSeen);
  const [settings, setSettings] = useState(loadMonitorSettings);
  // The text of the prefix field is its own state. A field that re-joins the parsed list swallows the separator while the user types.
  const [excludeText, setExcludeText] = useState(() => settings.exclude.join(", "));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadingSettings, setLoadingSettings] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "pending" | "saved" | { error: string }>("idle");
  const canNotify = typeof Notification !== "undefined" && !backend.isDesktop();

  useEffect(() => {
    if (open) markSeen();
  }, [open, markSeen, events.length]);

  // Debounced write. `pending` holds the value that still has to reach the backend.
  const pending = useRef<MonitorSettings | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(async () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const next = pending.current;
    if (!next) return;
    pending.current = null;
    try {
      await backend.setMonitorSettings(next);
      if (pending.current === null) setSaveState("saved");
    } catch (e) {
      // Keep the value for the Retry button unless a newer edit replaced it.
      pending.current ??= next;
      setSaveState({ error: (e as Error).message });
    }
  }, []);

  const update = (next: MonitorSettings) => {
    setSettings(next);
    remember(next);
    pending.current = next;
    setSaveState("pending");
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(flush, SAVE_DELAY_MS);
  };

  const pull = useCallback(async () => {
    setLoadingSettings(true);
    try {
      const loaded = await refreshMonitorSettings();
      // An edit made while the request ran is newer than the answer.
      if (pending.current === null) {
        setSettings(loaded);
        setExcludeText(loaded.exclude.join(", "));
      } else {
        remember(pending.current);
      }
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      setLoadingSettings(false);
    }
  }, []);

  // Open: read the backend value. Close or unmount: send a waiting edit now.
  useEffect(() => {
    if (!open) return;
    void pull();
    return () => {
      if (timer.current !== null) void flush();
    };
  }, [open, pull, flush]);

  const enableNotifications = async () => {
    if (canNotify && Notification.permission === "default") await Notification.requestPermission();
    if (canNotify && Notification.permission === "denied") toast.error("The browser blocks notifications for this page. Allow them in the site settings.");
    update({ ...settings, notify: true });
  };

  return (
    <Dialog open={open} onClose={onClose} variant="drawer" labelledBy={titleId} className="max-w-lg! glass overflow-y-auto">
      <div className="p-6 space-y-5">
        <div className="flex items-start justify-between">
          <div>
            <h2 id={titleId} className="text-lg font-bold text-white">
              Job changes
            </h2>
            <p className="text-xs text-gray-500 mt-1">
              mac-dash watches the five launchd folders all the time. Every plist that an app adds, changes or removes is recorded here. A job that
              exits with an error is recorded as failed.
            </p>
          </div>
          <button type="button" aria-label="Close" onClick={onClose} className="p-2 rounded-lg hover:bg-white/[0.06] text-gray-400">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="rounded-xl border border-white/[0.06] bg-black/20 p-3 space-y-2">
          <div className="flex items-center gap-2">
            {settings.notify ? <Bell className="w-4 h-4 text-cyan-400" /> : <BellOff className="w-4 h-4 text-gray-500" />}
            <span className="text-sm text-gray-300 flex-1">Notifications</span>
            <button
              type="button"
              aria-pressed={settings.notify}
              onClick={() => (settings.notify ? update({ ...settings, notify: false }) : enableNotifications())}
              className="px-2.5 py-1 rounded-lg text-xs bg-white/[0.06] text-gray-300 hover:bg-white/[0.1]"
            >
              {settings.notify ? "On" : "Off"}
            </button>
          </div>
          <label className="block space-y-1">
            <span className="text-[11px] text-gray-500">Do not notify for labels that start with</span>
            <input
              type="text"
              value={excludeText}
              placeholder="com.apple., com.google."
              spellCheck={false}
              onChange={(e) => {
                setExcludeText(e.target.value);
                update({ ...settings, exclude: parsePrefixes(e.target.value) });
              }}
              className={cn(inputClass, "font-mono text-xs")}
            />
          </label>
          <p className="text-[11px] text-gray-600">
            {backend.isDesktop()
              ? "The desktop app posts a macOS notification for every change that these settings allow."
              : "The browser notifies while this tab is in the background. With no dashboard open, the server posts a macOS notification."}
          </p>
          <p className="text-[11px] text-gray-600" aria-live="polite">
            {saveState === "pending" ? "Saving…" : saveState === "saved" ? "Saved. The settings apply to every client and to the native notifications." : ""}
          </p>
          {typeof saveState === "object" && (
            <InlineError title="The settings did not reach the backend. This browser keeps them." message={saveState.error} onRetry={flush} />
          )}
          {loadError && typeof saveState !== "object" && (
            <InlineError
              title="The settings could not be read from the backend. The values of this browser are shown."
              message={loadError}
              onRetry={pull}
              retrying={loadingSettings}
            />
          )}
        </div>

        <div className="flex items-center">
          <h3 className="text-xs font-semibold text-gray-400 flex-1">History ({events.length})</h3>
          {events.length > 0 && (
            <button
              type="button"
              onClick={() => backend.clearJobEvents().then(() => setEvents([])).catch((e: Error) => toast.error(e.message))}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs text-gray-500 hover:text-red-400 hover:bg-red-500/10"
            >
              <Trash2 className="w-3 h-3" /> Clear
            </button>
          )}
        </div>

        {events.length === 0 ? (
          <p className="text-sm text-gray-500">No changes recorded yet.</p>
        ) : (
          <ul className="space-y-1">
            {events.map((event) => {
              const kind = KIND[event.kind];
              return (
                <li key={event.id}>
                  <button
                    type="button"
                    disabled={event.kind === "removed"}
                    onClick={() => onOpenJob(event)}
                    className="w-full text-left flex gap-3 px-3 py-2 rounded-lg hover:bg-white/[0.04] disabled:hover:bg-transparent"
                  >
                    <kind.icon className={cn("w-4 h-4 mt-0.5 flex-shrink-0", kind.tone)} aria-hidden />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span
                          className={cn("text-[11px] font-medium flex-shrink-0", kind.tone)}
                          title={event.kind === "failed" ? (explainExitStatus(event.exitStatus ?? null) ?? undefined) : undefined}
                        >
                          {kindText(event)}
                        </span>
                        <span className="text-xs font-mono text-gray-200 truncate">{event.label}</span>
                      </div>
                      <div className="text-[10px] text-gray-600 font-mono truncate">{event.program ?? event.path}</div>
                      <div className="text-[10px] text-gray-600">
                        {scopeFor(event.category)?.title} · {new Date(event.at).toLocaleString()}
                      </div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Dialog>
  );
}

// ── Timeline ─────────────────────────────────────────────────────────

export function JobTimeline({ services, onSelect }: { services: ServiceInfo[]; onSelect: (s: ServiceInfo) => void }) {
  const { intervals, runs } = useMemo(() => {
    const now = new Date();
    const intervals = services.filter((s) => s.startInterval !== null && !s.disabled);
    const runs = services
      .filter((s) => s.calendar.length > 0 && !s.disabled)
      .flatMap((s) => s.calendar.flatMap((entry) => nextRuns(entry, now, 6).map((at) => ({ at, service: s, everyMinute: entry.Hour === undefined && entry.Minute === undefined }))))
      .sort((a, b) => a.at.getTime() - b.at.getTime())
      .slice(0, 150);
    return { intervals, runs };
  }, [services]);

  if (intervals.length === 0 && runs.length === 0) {
    return <p className="text-sm text-gray-500 px-2 py-6 text-center">No enabled job has a StartInterval or a calendar schedule.</p>;
  }

  let lastDay = "";
  return (
    <div className="space-y-3">
      {intervals.length > 0 && (
        <GlowCard padding="sm">
          <h3 className="px-2 py-1.5 text-sm font-semibold text-gray-300">Repeating</h3>
          {intervals.map((s) => (
            <TimelineRow key={`${s.category}/${s.label}`} when={`every ${formatInterval(s.startInterval!)}`} service={s} onSelect={onSelect} />
          ))}
        </GlowCard>
      )}
      {runs.length > 0 && (
        <GlowCard padding="sm">
          <h3 className="px-2 py-1.5 text-sm font-semibold text-gray-300">Next scheduled runs</h3>
          {runs.map((run, i) => {
            const day = run.at.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
            const header = day !== lastDay;
            lastDay = day;
            return (
              <div key={i}>
                {header && <div className="px-2 pt-3 pb-1 text-[11px] font-medium uppercase tracking-wide text-gray-600">{day}</div>}
                <TimelineRow
                  when={run.everyMinute ? "every minute" : run.at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                  service={run.service}
                  onSelect={onSelect}
                />
              </div>
            );
          })}
        </GlowCard>
      )}
    </div>
  );
}

function TimelineRow({ when, service, onSelect }: { when: string; service: ServiceInfo; onSelect: (s: ServiceInfo) => void }) {
  return (
    <button type="button" onClick={() => onSelect(service)} className="w-full flex items-center gap-3 px-2 py-1.5 rounded-lg hover:bg-white/[0.03] text-left">
      <span className="w-24 flex-shrink-0 text-xs font-mono text-cyan-400/80">{when}</span>
      <span className="text-[12px] font-mono text-gray-200 truncate">{service.label}</span>
      <span className="ml-auto text-[10px] text-gray-600 truncate max-w-[40%]">{service.program}</span>
    </button>
  );
}
