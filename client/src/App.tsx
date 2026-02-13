import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Shell } from "@/components/layout/Shell";
import { useWebSocket } from "@/hooks/useWebSocket";
import { api } from "@/lib/api";
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

  // Fetch version once
  useEffect(() => {
    api
      .get<{ version: string }>("/system/version")
      .then((r) => setVersion(r.version))
      .catch(() => {});
  }, []);

  // Shared fetch function for both initial load and manual refresh
  const fetchAll = useCallback(async () => {
    try {
      const [statsRes, servicesRes, processesRes, logsRes] =
        await Promise.allSettled([
          api.get<any>("/system/stats"),
          api.get<{ services: any[] }>("/services"),
          api.get<{ processes: any[] }>("/processes"),
          api.get<{ logs: any[] }>("/logs/recent?count=50"),
        ]);

      if (statsRes.status === "fulfilled") setStats(statsRes.value);
      if (servicesRes.status === "fulfilled")
        setServices(servicesRes.value.services);
      if (processesRes.status === "fulfilled")
        setProcesses(processesRes.value.processes);
      if (logsRes.status === "fulfilled")
        setLogEntries(logsRes.value.logs);
      recordData("poll");
    } catch {}
  }, [setStats, setServices, setProcesses, setLogEntries, recordData]);

  // REST API polling fallback (and initial fetch)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    // Initial data fetch
    fetchAll();

    // Poll every 10s as fallback if WS isn't connected (was 3s)
    // Smart polling: only fetch data relevant to the current page
    pollRef.current = setInterval(async () => {
      if (connected) return; // WS is handling it
      try {
        const fetches: Promise<any>[] = [
          api.get<any>("/system/stats").then((r) => setStats(r)),
        ];

        if (
          currentPage === "dashboard" ||
          currentPage === "services"
        ) {
          fetches.push(
            api
              .get<{ services: any[] }>("/services")
              .then((r) => setServices(r.services))
          );
        }

        if (
          currentPage === "dashboard" ||
          currentPage === "processes"
        ) {
          fetches.push(
            api
              .get<{ processes: any[] }>("/processes")
              .then((r) => setProcesses(r.processes))
          );
        }

        if (currentPage === "logs") {
          fetches.push(
            api
              .get<{ logs: any[] }>("/logs/recent?count=100")
              .then((r) => setLogEntries(r.logs))
          );
        }

        await Promise.allSettled(fetches);
        recordData("poll");
      } catch {}
    }, 10000);

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
    <Shell version={version} onRefresh={fetchAll}>
      {renderPage()}
    </Shell>
  );
}
