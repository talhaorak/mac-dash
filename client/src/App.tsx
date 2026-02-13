import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Shell } from "@/components/layout/Shell";
import { UpdateNotification } from "@/components/UpdateNotification";
import { useWebSocket } from "@/hooks/useWebSocket";
import { backend } from "@/lib/backend";
import {
  useNavStore,
  useSystemStore,
  useServicesStore,
  useProcessesStore,
  useLogsStore,
  useConnectionStore,
} from "@/stores/app";
import { DashboardPage } from "@/pages/DashboardPage";
import { ServicesPage } from "@/pages/ServicesPage";
import { ProcessesPage } from "@/pages/ProcessesPage";
import { LogsPage } from "@/pages/LogsPage";
import { PluginsPage } from "@/pages/PluginsPage";
import { PluginRenderer } from "@/components/PluginRenderer";
import { initPluginRuntime } from "@/lib/plugin-runtime";

// Initialize the plugin runtime (shared module registry) once at import time
initPluginRuntime();

// ── Map current page to the WS topics it actually needs ──────────────
function getTopicsForPage(page: string): string[] {
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
  const { currentPage } = useNavStore();
  const setStats = useSystemStore((s) => s.setStats);
  const setServices = useServicesStore((s) => s.setServices);
  const setProcesses = useProcessesStore((s) => s.setProcesses);
  const addLogEntry = useLogsStore((s) => s.addEntry);
  const setLogEntries = useLogsStore((s) => s.setEntries);
  const setWsConnected = useConnectionStore((s) => s.setWsConnected);
  const recordData = useConnectionStore((s) => s.recordDataReceived);
  const [version, setVersion] = useState<string | null>(null);

  // ── Smart topic subscription based on current page ─────────────────
  const topics = useMemo(() => getTopicsForPage(currentPage), [currentPage]);

  const handleMessage = useCallback(
    (topic: string, _type: string, data: any) => {
      recordData("ws");
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
          addLogEntry(data);
          break;
      }
    },
    [setStats, setServices, setProcesses, addLogEntry, recordData]
  );

  const { connected } = useWebSocket({
    topics,
    onMessage: handleMessage,
  });

  // Sync WS connected state to connection store
  useEffect(() => {
    setWsConnected(connected);
  }, [connected, setWsConnected]);

  // Fetch version once (only in web mode; desktop uses package version)
  useEffect(() => {
    if (backend.isDesktop()) {
      setVersion("desktop");
    } else {
      fetch("/api/system/version")
        .then((r) => r.json())
        .then((r) => setVersion(r.version))
        .catch(() => {});
    }
  }, []);

  // Shared fetch function for both initial load and manual refresh
  const fetchAll = useCallback(async () => {
    try {
      const [statsRes, servicesRes, processesRes, logsRes] =
        await Promise.allSettled([
          backend.getSystemStats(),
          backend.getServices(),
          backend.getProcesses(),
          backend.getRecentLogs(50),
        ]);

      if (statsRes.status === "fulfilled") setStats(statsRes.value as any);
      if (servicesRes.status === "fulfilled") {
        const val = servicesRes.value as any;
        setServices(val.services || val);
      }
      if (processesRes.status === "fulfilled") {
        const val = processesRes.value as any;
        setProcesses(val.processes || val);
      }
      if (logsRes.status === "fulfilled") {
        const val = logsRes.value as any;
        setLogEntries(val.logs || val);
      }
      recordData("poll");
    } catch {}
  }, [setStats, setServices, setProcesses, setLogEntries, recordData]);

  // REST API polling fallback (and initial fetch)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    // Initial data fetch
    fetchAll();

    // Poll every 3s in desktop mode (no WS), 10s in web mode as fallback
    const pollInterval = backend.isDesktop() ? 3000 : 10000;
    pollRef.current = setInterval(async () => {
      if (connected && !backend.isDesktop()) return; // WS is handling it
      try {
        const fetches: Promise<any>[] = [
          backend.getSystemStats().then((r: any) => setStats(r)),
        ];

        if (
          currentPage === "dashboard" ||
          currentPage === "services"
        ) {
          fetches.push(
            backend.getServices().then((r: any) => setServices(r.services || r))
          );
        }

        if (
          currentPage === "dashboard" ||
          currentPage === "processes"
        ) {
          fetches.push(
            backend.getProcesses().then((r: any) => setProcesses(r.processes || r))
          );
        }

        if (currentPage === "logs") {
          fetches.push(
            backend.getRecentLogs(100).then((r: any) => setLogEntries(r.logs || r))
          );
        }

        await Promise.allSettled(fetches);
        recordData("poll");
      } catch {}
    }, pollInterval);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [
    connected,
    currentPage,
    setStats,
    setServices,
    setProcesses,
    setLogEntries,
    fetchAll,
    recordData,
  ]);

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
    </>
  );
}
