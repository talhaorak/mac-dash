import { useEffect, useId, useMemo, useState } from "react";
import { Bell, BellOff, FilePlus2, FileX2, FilePen, Trash2, X } from "lucide-react";
import { Dialog } from "@/components/ui/Dialog";
import { GlowCard } from "@/components/ui/GlowCard";
import { toast } from "@/components/ui/Toast";
import { backend, type JobEvent, type LoginItem, type StartupExtras } from "@/lib/backend";
import { useJobEventsStore, type ServiceInfo } from "@/stores/app";
import { cn } from "@/lib/utils";
import { formatInterval, nextRuns, scopeFor } from "@shared/launchd";
import { inputClass } from "./fields";

// ── Monitor settings (per browser) ───────────────────────────────────

const SETTINGS_KEY = "macdash.jobMonitor";

export interface MonitorSettings {
  notify: boolean;
  /** Label prefixes that never raise a notification, e.g. "com.apple." */
  exclude: string[];
}

export function loadMonitorSettings(): MonitorSettings {
  try {
    const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "");
    return { notify: parsed.notify !== false, exclude: Array.isArray(parsed.exclude) ? parsed.exclude : [] };
  } catch {
    return { notify: true, exclude: [] };
  }
}

const KIND = {
  added: { icon: FilePlus2, text: "Added", tone: "text-green-400" },
  modified: { icon: FilePen, text: "Changed", tone: "text-amber-400" },
  removed: { icon: FileX2, text: "Removed", tone: "text-red-400" },
} as const;

/** Browser notification for a job change. Only fires while the dashboard is not in front. */
export function notifyJobEvent(event: JobEvent): void {
  const settings = loadMonitorSettings();
  if (!settings.notify || settings.exclude.some((p) => p && event.label.startsWith(p))) return;
  if (backend.isDesktop()) return; // the desktop shell posts native notifications itself
  if (typeof Notification === "undefined" || Notification.permission !== "granted" || !document.hidden) return;
  new Notification(`launchd job ${KIND[event.kind].text.toLowerCase()}`, { body: `${event.label}\n${event.path}`, tag: event.id });
}

export function JobEventsDrawer({ open, onClose, onOpenJob }: { open: boolean; onClose: () => void; onOpenJob: (event: JobEvent) => void }) {
  const titleId = useId();
  const events = useJobEventsStore((s) => s.events);
  const setEvents = useJobEventsStore((s) => s.setEvents);
  const markSeen = useJobEventsStore((s) => s.markSeen);
  const [settings, setSettings] = useState(loadMonitorSettings);
  const canNotify = typeof Notification !== "undefined" && !backend.isDesktop();

  useEffect(() => {
    if (open) markSeen();
  }, [open, markSeen, events.length]);

  const update = (next: MonitorSettings) => {
    setSettings(next);
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  };

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
              mac-dash watches the five launchd folders all the time. Every plist that an app adds, changes or removes is recorded here.
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
              value={settings.exclude.join(", ")}
              placeholder="com.apple., com.google."
              onChange={(e) => update({ ...settings, exclude: e.target.value.split(/[,\s]+/).filter(Boolean) })}
              className={cn(inputClass, "font-mono text-xs")}
            />
          </label>
          <p className="text-[11px] text-gray-600">
            {backend.isDesktop()
              ? "The desktop app posts a macOS notification for every change."
              : "The browser notifies while this tab is in the background. With no dashboard open, the server posts a macOS notification."}
          </p>
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
                        <span className={cn("text-[11px] font-medium", kind.tone)}>{kind.text}</span>
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

// ── Startup mechanisms that are not launchd plists ───────────────────

export function StartupExtrasCard() {
  const [extras, setExtras] = useState<StartupExtras | null>(null);
  const [loginItems, setLoginItems] = useState<LoginItem[] | null>(null);
  const [loadingLogin, setLoadingLogin] = useState(false);

  useEffect(() => {
    backend.getStartupExtras().then(setExtras).catch(() => {});
  }, []);

  const loadLoginItems = async () => {
    setLoadingLogin(true);
    try {
      setLoginItems(await backend.getLoginItems());
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoadingLogin(false);
    }
  };

  const groups: { title: string; hint: string; rows: { main: string; sub?: string }[] | null }[] = [
    { title: "cron", hint: "Your crontab (crontab -l)", rows: extras?.cron.map((line) => ({ main: line })) ?? null },
    { title: "Privileged helper tools", hint: "/Library/PrivilegedHelperTools", rows: extras?.helperTools.map((h) => ({ main: h.name, sub: h.path })) ?? null },
    { title: "Startup items", hint: "Legacy /Library/StartupItems", rows: extras?.startupItems.map((h) => ({ main: h.name, sub: h.path })) ?? null },
  ];

  return (
    <GlowCard padding="sm">
      <h2 className="px-2 py-1.5 text-sm font-semibold text-gray-300">Other startup mechanisms (read-only)</h2>
      <div className="grid gap-3 md:grid-cols-2 p-2">
        {groups.map((g) => (
          <ExtrasGroup key={g.title} title={g.title} hint={g.hint} rows={g.rows} />
        ))}
        <div>
          {loginItems === null ? (
            <div className="space-y-1.5">
              <h3 className="text-xs font-semibold text-gray-400">Login items</h3>
              <p className="text-[11px] text-gray-600">Reading them goes through System Events. macOS asks for Automation permission the first time.</p>
              <button
                type="button"
                disabled={loadingLogin}
                onClick={loadLoginItems}
                className="px-2.5 py-1 rounded-lg text-xs bg-white/[0.06] text-gray-300 hover:bg-white/[0.1] disabled:opacity-40"
              >
                {loadingLogin ? "Reading…" : "Read login items"}
              </button>
            </div>
          ) : (
            <ExtrasGroup
              title="Login items"
              hint="System Settings > General > Login Items"
              rows={loginItems.map((li) => ({ main: li.name + (li.hidden ? " (hidden)" : ""), sub: li.path }))}
            />
          )}
        </div>
      </div>
    </GlowCard>
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
        <p className="text-[11px] text-gray-600">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-[11px] text-gray-600">None.</p>
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
