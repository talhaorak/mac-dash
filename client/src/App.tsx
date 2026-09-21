import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Shell } from "@/components/layout/Shell";
import { UpdateNotification } from "@/components/UpdateNotification";
import { Toaster } from "@/components/ui/Toast";
import { useWebSocket } from "@/hooks/useWebSocket";
import { backend, type JobEvent } from "@/lib/backend";
import { toast } from "@/components/ui/Toast";
import { notifyJobEvent, openJobFromNotification, refreshMonitorSettings } from "@/components/jobs/JobPanels";
import { jobRefFromParts } from "@/lib/router";
import { useT, type TKey } from "@/i18n";
import {
  useNavStore,
  useJobEventsStore,
  useSystemStore,
  useServicesStore,
  useProcessesStore,
  useLogsStore,
  useConnectionStore,
  type LogEntry,
} from "@/stores/app";
import { DashboardPage } from "@/pages/DashboardPage";
import { ServicesPage } from "@/pages/ServicesPage";
import { ProcessesPage } from "@/pages/ProcessesPage";
import { LogsPage } from "@/pages/LogsPage";
import { PluginsPage } from "@/pages/PluginsPage";
import { PluginRenderer } from "@/components/PluginRenderer";
import { useFileDropToCreate } from "@/components/jobs/FileDrop";


// Poll every 3s in desktop mode (no WS), 10s in web mode as WS fallback
const DESKTOP_POLL_MS = 3000;
const WEB_FALLBACK_POLL_MS = 10000;

const ALL_TOPICS = ["system", "services", "processes", "logs"];

/** Dictionary key for the document title of each page id (the plain ones; "plugin:<id>" is handled separately). */
const PAGE_TITLE_KEYS: Partial<Record<string, TKey>> = {
  dashboard: "app.nav.dashboard",
  services: "app.nav.services",
  processes: "app.nav.processes",
  logs: "app.nav.logs",
  plugins: "app.nav.plugins",
};

const JOB_EVENT_TOAST_KEYS: Record<"added" | "modified" | "removed", TKey> = {
  added: "app.toast.jobAdded",
  modified: "app.toast.jobChanged",
  removed: "app.toast.jobRemoved",
};

// ── Map current page to the data topics it actually needs ────────────
// The same list drives the WS subscription and the REST polling fallback.
function getTopicsForPage(page: string): string[] {
  // launchd job changes are wanted on every page: they raise a toast and the badge on Services.
  return ["job-events", ...getDataTopicsForPage(page)];
}

function getDataTopicsForPage(page: string): string[] {
  switch (page) {
    case "dashboard":
      return ["system", "services", "processes"]; // overview needs all
    case "services":
      return ["system", "services"];
    case "processes":
      return ["system", "processes"];
    case "logs":
      return ["system", "logs"]; // only page that needs logs
    default:
      return ["system"]; // plugins / settings just need basic stats
  }
}

export default function App() {
  // Desktop: drop an app, a script or a folder on the window to create a job for it.
  useFileDropToCreate(useNavStore((s) => s.openEditor));

  const { t, locale } = useT();
  const currentPage = useNavStore((s) => s.currentPage);
  const setStats = useSystemStore((s) => s.setStats);
  const setServices = useServicesStore((s) => s.setServices);
  const setProcesses = useProcessesStore((s) => s.setProcesses);
  const addLogEntries = useLogsStore((s) => s.addEntries);
  const setLogEntries = useLogsStore((s) => s.setEntries);
  const setWsConnected = useConnectionStore((s) => s.setWsConnected);
  const recordData = useConnectionStore((s) => s.recordDataReceived);
  const addJobEvent = useJobEventsStore((s) => s.addEvent);
  const setJobEvents = useJobEventsStore((s) => s.setEvents);
  const [version, setVersion] = useState<string | null>(null);

  // Several tabs or windows can show different pages: the title tells them apart.
  useEffect(() => {
    if (currentPage === "dashboard") {
      document.title = "mac-dash";
      return;
    }
    if (currentPage.startsWith("plugin:")) {
      // A plugin's own name is not in the dictionary: it comes from the plugin itself.
      const name = currentPage.slice("plugin:".length);
      document.title = `${name.charAt(0).toUpperCase()}${name.slice(1)} · mac-dash`;
      return;
    }
    const titleKey = PAGE_TITLE_KEYS[currentPage];
    document.title = titleKey ? `${t(titleKey)} · mac-dash` : "mac-dash";
  }, [currentPage, t, locale]);

  // ── Smart topic subscription based on current page ─────────────────
  const topics = useMemo(() => getTopicsForPage(currentPage), [currentPage]);

  // ── launchd job monitor: history on start, then live changes ───────
  const handleJobEvent = useCallback(
    (event: JobEvent) => {
      addJobEvent(event);
      notifyJobEvent(event);
      if (document.hidden) return;
      if (event.kind === "failed") {
        toast.error(
          event.exitStatus !== undefined
            ? t("app.toast.jobFailedExit", { label: event.label, status: event.exitStatus })
            : t("app.toast.jobFailed", { label: event.label })
        );
      } else {
        toast.info(t(JOB_EVENT_TOAST_KEYS[event.kind], { label: event.label }));
      }
    },
    [addJobEvent, t]
  );

  useEffect(() => {
    backend.getJobEvents().then(setJobEvents).catch(() => {});
    // notifyJobEvent reads the monitor settings synchronously: fill its cache now. On failure it keeps the localStorage copy.
    refreshMonitorSettings().catch(() => {});
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    backend.onJobEvent(handleJobEvent).then((off) => (cancelled ? off() : (unlisten = off)));
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [handleJobEvent, setJobEvents]);

  // ── Desktop: a click on a native notification opens the job ────────
  // The shell emits "open-job" with { label, category }. An older shell never emits it: then nothing happens here.
  useEffect(() => {
    if (!backend.isDesktop()) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<{ label?: unknown; category?: unknown; kind?: unknown }>("open-job", (e) => {
          // The payload crosses a process border: check it like a URL.
          const payload = e.payload ?? {};
          const job = jobRefFromParts(payload.label, payload.category);
          if (job) openJobFromNotification(job, payload.kind === "removed" ? "removed" : undefined);
        })
      )
      .then((off) => (cancelled ? off() : (unlisten = off)))
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // `log stream` can deliver hundreds of lines per second. One store update per line
  // re-rendered the log list per line and tripped React's nested update limit.
  const logBuffer = useRef<LogEntry[]>([]);
  const lastRecordedAt = useRef(0);
  useEffect(() => {
    const timer = setInterval(() => {
      if (logBuffer.current.length === 0) return;
      addLogEntries(logBuffer.current);
      logBuffer.current = [];
    }, 250);
    return () => clearInterval(timer);
  }, [addLogEntries]);

  const handleMessage = useCallback(
    (topic: string, _type: string, data: any) => {
      const now = Date.now();
      if (now - lastRecordedAt.current > 1000) {
        lastRecordedAt.current = now;
        recordData("ws");
      }
      switch (topic) {
        case "system":
          setStats(data);
          break;
        case "services":
          setServices(data);
          break;
        case "processes":
          setProcesses(data);
          break;
        case "logs":
          logBuffer.current.push(data);
          break;
        case "job-events":
          handleJobEvent(data);
          break;
      }
    },
    [setStats, setServices, setProcesses, recordData, handleJobEvent]
  );

  const { connected } = useWebSocket({
    topics,
    onMessage: handleMessage,
  });

  // Sync WS connected state to connection store
  useEffect(() => {
    setWsConnected(connected);
  }, [connected, setWsConnected]);

  // Web: the server's version. Desktop: the app bundle's version.
  useEffect(() => {
    backend.getVersion().then(setVersion);
  }, []);

  // Fetch the given topics over REST / Tauri commands
  const fetchTopics = useCallback(
    async (
      wanted: readonly string[],
      opts: { logCount: number; respectLogPause: boolean }
    ) => {
      const tasks: Promise<unknown>[] = [];

      if (wanted.includes("system")) {
        tasks.push(backend.getSystemStats().then((r: any) => setStats(r)));
      }
      if (wanted.includes("services")) {
        tasks.push(
          backend.getServices().then((r: any) => setServices(r.services || r))
        );
      }
      if (wanted.includes("processes")) {
        tasks.push(
          backend.getProcesses().then((r: any) => setProcesses(r.processes || r))
        );
      }
      if (wanted.includes("logs")) {
        tasks.push(
          backend.getRecentLogs(opts.logCount).then((r: any) => {
            // A background poll must not replace the list while the user has paused it.
            if (opts.respectLogPause && useLogsStore.getState().paused) return;
            setLogEntries(r.logs || r);
          })
        );
      }

      const results = await Promise.allSettled(tasks);
      if (results.some((r) => r.status === "fulfilled")) recordData("poll");
    },
    [setStats, setServices, setProcesses, setLogEntries, recordData]
  );

  // Full fetch: initial load and the manual Refresh button
  const fetchAll = useCallback(
    () => fetchTopics(ALL_TOPICS, { logCount: 50, respectLogPause: false }),
    [fetchTopics]
  );

  // One initial fetch on mount
  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  // ── REST polling ───────────────────────────────────────────────────
  // Polling runs only when there is no live WS feed: always in the desktop
  // build, and in the web build while the socket is down.
  const needsPolling = backend.isDesktop() || !connected;
  // Page whose data is already requested. The initial fetchAll covers the first page.
  const fetchedPageRef = useRef(currentPage);

  useEffect(() => {
    if (!needsPolling) {
      // The WS subscription delivers the data for this page.
      fetchedPageRef.current = currentPage;
      return;
    }

    const intervalMs = backend.isDesktop()
      ? DESKTOP_POLL_MS
      : WEB_FALLBACK_POLL_MS;
    let timer: ReturnType<typeof setInterval> | null = null;
    let inFlight = false;

    const poll = () => {
      if (document.hidden || inFlight) return;
      inFlight = true;
      fetchTopics(topics, { logCount: 100, respectLogPause: true }).finally(
        () => {
          inFlight = false;
        }
      );
    };
    const start = () => {
      if (timer === null) timer = setInterval(poll, intervalMs);
    };
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    // Pause while the window is hidden. Refresh once when it becomes visible.
    const onVisibilityChange = () => {
      if (document.hidden) {
        stop();
      } else {
        poll();
        start();
      }
    };

    // Navigation: fetch what the new page needs now, not at the next tick.
    if (fetchedPageRef.current !== currentPage) {
      fetchedPageRef.current = currentPage;
      poll();
    }
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [needsPolling, currentPage, topics, fetchTopics]);

  const renderPage = () => {
    // Dynamic plugin pages: "plugin:<id>" → PluginRenderer
    if (currentPage.startsWith("plugin:")) {
      const pluginId = currentPage.slice("plugin:".length);
      return <PluginRenderer pluginId={pluginId} />;
    }

    switch (currentPage) {
      case "dashboard":
        return <DashboardPage />;
      case "services":
        return <ServicesPage />;
      case "processes":
        return <ProcessesPage />;
      case "logs":
        return <LogsPage />;
      case "plugins":
        return <PluginsPage />;
      default:
        return <DashboardPage />;
    }
  };

  return (
    <>
      <Shell version={version} onRefresh={fetchAll}>
        {renderPage()}
      </Shell>
      <UpdateNotification />
      <Toaster />
    </>
  );
}
