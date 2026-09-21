import { useEffect } from "react";
import { create } from "zustand";
import type { JobCategory } from "@shared/launchd";
import { backend, type JobEvent, type JobMeta } from "@/lib/backend";
import type { JobEditorTarget } from "@/components/jobs/JobEditor";
import {
  DEFAULT_SERVICES_ROUTE,
  DEFAULT_TEMPLATE_ID,
  formatRoute,
  onLocationRouteChange,
  pageIdOf,
  readLocationRoute,
  routeForPage,
  sameRoute,
  writeLocationRoute,
  type EditorRoute,
  type NavigateMode,
  type Route,
  type ServicesRoute,
} from "@/lib/router";

// System stats store
interface SystemStats {
  cpu: {
    user: number;
    sys: number;
    idle: number;
    model: string;
    cores: number;
    loadAvg: [number, number, number];
  };
  memory: {
    total: number;
    used: number;
    free: number;
    wired: number;
    compressed: number;
    usedPercent: number;
  };
  disk: {
    total: number;
    used: number;
    free: number;
    usedPercent: number;
    mountPoint: string;
  };
  uptime: string;
  hostname: string;
  osVersion: string;
  processCount: number;
  threadCount: number;
}

interface SystemStore {
  stats: SystemStats | null;
  history: { cpu: number; mem: number; time: number }[];
  setStats: (stats: SystemStats) => void;
}

export const useSystemStore = create<SystemStore>((set, get) => ({
  stats: null,
  history: [],
  setStats: (stats) => {
    const cpuUsed = stats.cpu.user + stats.cpu.sys;
    const history = [
      ...get().history.slice(-59),
      { cpu: cpuUsed, mem: stats.memory.usedPercent, time: Date.now() },
    ];
    set({ stats, history });
  },
}));

// Services store
export interface ServiceInfo {
  label: string;
  pid: number | null;
  lastExitStatus: number | null;
  status: "running" | "stopped" | "error" | "unknown";
  category: JobCategory;
  plistPath: string | null;
  program: string | null;
  programArguments: string[] | null;
  runAtLoad: boolean | null;
  enabled: boolean;
  loaded: boolean;
  disabled: boolean;
  triggers: string[];
  writable: boolean;
  needsAdmin: boolean;
  userName: string | null;
  unreadable: boolean;
  quarantined: boolean;
  startInterval: number | null;
  calendar: Record<string, number>[];
}

interface ServicesStore {
  services: ServiceInfo[];
  loading: boolean;
  setServices: (services: ServiceInfo[]) => void;
  setLoading: (loading: boolean) => void;
}

export const useServicesStore = create<ServicesStore>((set) => ({
  services: [],
  loading: true,
  setServices: (services) => set({ services, loading: false }),
  setLoading: (loading) => set({ loading }),
}));

// launchd job change history (docs/backend-contract.md, "Monitor")
interface JobEventsStore {
  events: JobEvent[]; // newest first
  unseen: number;
  setEvents: (events: JobEvent[]) => void;
  addEvent: (event: JobEvent) => void;
  markSeen: () => void;
}

export const useJobEventsStore = create<JobEventsStore>((set) => ({
  events: [],
  unseen: 0,
  setEvents: (events) => set({ events }),
  addEvent: (event) =>
    set((s) =>
      s.events.some((e) => e.id === event.id)
        ? s
        : { events: [event, ...s.events].slice(0, 500), unseen: s.unseen + 1 }
    ),
  markSeen: () => set({ unseen: 0 }),
}));

// Processes store
export interface ProcessInfo {
  pid: number;
  ppid: number;
  uid: number;
  user: string;
  cpu: number;
  mem: number;
  rss: number;
  elapsed: string;
  command: string;
  path: string;
  args: string;
}

interface ProcessesStore {
  processes: ProcessInfo[];
  loading: boolean;
  setProcesses: (processes: ProcessInfo[]) => void;
  setLoading: (loading: boolean) => void;
}

export const useProcessesStore = create<ProcessesStore>((set) => ({
  processes: [],
  loading: true,
  setProcesses: (processes) => set({ processes, loading: false }),
  setLoading: (loading) => set({ loading }),
}));

// Logs store
export interface LogEntry {
  timestamp: string;
  level: "error" | "warning" | "info" | "debug" | "default";
  process: string;
  pid: number | null;
  message: string;
  subsystem: string | null;
  category: string | null;
}

interface LogsStore {
  entries: LogEntry[];
  paused: boolean;
  maxEntries: number;
  addEntries: (batch: LogEntry[]) => void;
  setEntries: (entries: LogEntry[]) => void;
  setPaused: (paused: boolean) => void;
  clear: () => void;
}

export const useLogsStore = create<LogsStore>((set, get) => ({
  entries: [],
  paused: false,
  maxEntries: 500,
  addEntries: (batch) => {
    if (get().paused || batch.length === 0) return;
    set((state) => ({ entries: [...state.entries, ...batch].slice(-state.maxEntries) }));
  },
  setEntries: (entries) => set({ entries }),
  setPaused: (paused) => set({ paused }),
  clear: () => set({ entries: [] }),
}));

// Notes, tags and icons of the jobs, by `metaKey`. The Services page and the quick switcher share one copy.
interface JobMetaStore {
  meta: Record<string, JobMeta>;
  /** Message of the last failed load. `meta` keeps the last good value. */
  error: string | null;
  loading: boolean;
  load: () => Promise<void>;
  setOne: (key: string, meta: JobMeta) => void;
  removeOne: (key: string) => void;
}

export const useJobMetaStore = create<JobMetaStore>((set, get) => ({
  meta: {},
  error: null,
  loading: false,
  load: async () => {
    if (get().loading) return;
    set({ loading: true });
    try {
      set({ meta: await backend.getJobMeta(), error: null, loading: false });
    } catch (e) {
      set({ error: (e as Error).message || "The request failed.", loading: false });
    }
  },
  setOne: (key, meta) => set((s) => ({ meta: { ...s.meta, [key]: meta } })),
  removeOne: (key) => set((s) => ({ meta: Object.fromEntries(Object.entries(s.meta).filter(([k]) => k !== key)) })),
}));

// Every job's plist as JSON, for the smart folder rules over launchd keys.
// The answer is large, so nothing asks for it until a folder needs it.

export type JobPlists = Record<string, Record<string, unknown>>;

/** A cached answer older than this is read again on the next request. */
export const JOB_PLISTS_TTL_MS = 60_000;

interface JobPlistsStore {
  /** Null until the first answer. Keyed by `metaKey`. */
  plists: JobPlists | null;
  /** Message of the last failed load. `plists` keeps the last good value. */
  error: string | null;
  loading: boolean;
  /** Time of the last attempt, successful or not. A failed attempt is not repeated before the TTL ends. */
  attemptedAt: number;
  /** Size of the job list at the last attempt. Another size means that a job came or went. */
  serviceCount: number;
  /** Load when there is no answer, when the answer is older than the TTL, or when the job list changed size. */
  ensure: (serviceCount: number, options?: { force?: boolean }) => void;
}

export const useJobPlistsStore = create<JobPlistsStore>((set, get) => ({
  plists: null,
  error: null,
  loading: false,
  attemptedAt: 0,
  serviceCount: -1,
  ensure: (serviceCount, options) => {
    const state = get();
    if (state.loading) return;
    const fresh = state.attemptedAt !== 0 && Date.now() - state.attemptedAt < JOB_PLISTS_TTL_MS && state.serviceCount === serviceCount;
    if (fresh && !options?.force) return;
    set({ loading: true, attemptedAt: Date.now(), serviceCount });
    backend
      .getJobPlists()
      .then((plists) => set({ plists, error: null, loading: false }))
      .catch((e: Error) => set({ error: e.message || "The request failed.", loading: false }));
  },
}));

/**
 * The plists of all jobs, loaded only while `needed` is true.
 * `plists` is null while the first load runs and after a failed first load.
 */
export function useJobPlists(needed: boolean): { plists: JobPlists | null; loading: boolean; error: string | null; retry: () => void } {
  const services = useServicesStore((s) => s.services);
  const plists = useJobPlistsStore((s) => s.plists);
  const loading = useJobPlistsStore((s) => s.loading);
  const error = useJobPlistsStore((s) => s.error);
  const ensure = useJobPlistsStore((s) => s.ensure);

  // The job list arrives again every few seconds. `ensure` answers from the cache until the TTL ends.
  useEffect(() => {
    if (needed && services.length > 0) ensure(services.length);
  }, [needed, services, ensure]);

  return { plists: needed ? plists : null, loading: needed && loading, error: needed ? error : null, retry: () => ensure(services.length, { force: true }) };
}

// Navigation store. The URL hash is the source of truth (lib/router.ts): every change here goes to the
// address bar, and Back, Forward and a typed hash come back through `onLocationRouteChange`.
interface NavStore {
  route: Route;
  /** Page id of `route`: "dashboard", "services", … or "plugin:<id>". */
  currentPage: string;
  sidebarCollapsed: boolean;
  /** `process` of the logs route. */
  logProcessFilter: string | null;
  /** `pid` of the processes route. */
  targetProcessPid: number | null;
  /** An open editor whose target a URL cannot hold, e.g. a new job built from a dropped file. A reload does not restore it. */
  transientEditor: JobEditorTarget | null;
  /** "push" adds a Back step. "replace" is for filter changes and typing. */
  navigate: (route: Route, mode?: NavigateMode) => void;
  /** Change fields of the services route. From another page it starts at the default services route. */
  patchServices: (fields: Partial<Omit<ServicesRoute, "page">>, mode?: NavigateMode) => void;
  /** Open a page without parameters. Does nothing when the page is already shown. */
  setPage: (page: string) => void;
  toggleSidebar: () => void;
  navigateToLogs: (processName?: string) => void;
  navigateToProcess: (pid: number) => void;
  /** Open the detail drawer of a job. Without a category the first job with the label opens. */
  navigateToService: (label: string, category?: JobCategory) => void;
  /** Open the job editor on the Services page, from any page. The target goes to the URL when the URL can hold it. */
  openEditor: (target: JobEditorTarget) => void;
  closeEditor: () => void;
}

/** The URL form of an editor target. Null for a target with data that is not in the route grammar. */
function editorRouteOf(target: JobEditorTarget): EditorRoute | null {
  if (target.mode !== "new") return { mode: target.mode, job: target.job };
  const hasExtraData = Object.entries(target).some(([key, value]) => key !== "mode" && key !== "templateId" && value !== undefined);
  return hasExtraData ? null : { mode: "new", templateId: target.templateId ?? DEFAULT_TEMPLATE_ID };
}

const routeFields = (route: Route) => ({
  route,
  currentPage: pageIdOf(route),
  logProcessFilter: route.page === "logs" ? route.process : null,
  targetProcessPid: route.page === "processes" ? route.pid : null,
});

export const useNavStore = create<NavStore>((set, get) => ({
  ...routeFields(readLocationRoute()),
  sidebarCollapsed: false,
  transientEditor: null,
  navigate: (route, mode = "push") => {
    writeLocationRoute(route, mode);
    if (sameRoute(route, get().route)) return;
    // The transient editor belongs to the Services page.
    set(route.page === "services" ? routeFields(route) : { ...routeFields(route), transientEditor: null });
  },
  patchServices: (fields, mode = "replace") => {
    const current = get().route;
    get().navigate({ ...(current.page === "services" ? current : DEFAULT_SERVICES_ROUTE), ...fields }, mode);
  },
  setPage: (page) => {
    if (page !== get().currentPage) get().navigate(routeForPage(page));
  },
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  navigateToLogs: (processName) => get().navigate({ page: "logs", process: processName || null }),
  navigateToProcess: (pid) => get().navigate({ page: "processes", pid }),
  // The filters of an open Services page stay. An open editor or panel would cover the drawer, so both close.
  navigateToService: (label, category) => {
    set({ transientEditor: null });
    get().patchServices({ job: { label, category: category ?? null }, editor: null, panel: null }, "push");
  },
  openEditor: (target) => {
    const editor = editorRouteOf(target);
    get().patchServices({ editor }, "push");
    set({ transientEditor: editor ? null : target });
  },
  closeEditor: () => {
    const { route, transientEditor } = get();
    if (transientEditor) set({ transientEditor: null });
    if (route.page === "services" && route.editor) get().patchServices({ editor: null }, "push");
  },
}));

if (typeof window !== "undefined") {
  // A sloppy or unknown hash becomes the canonical one, so a copied link is always clean.
  const initial = useNavStore.getState().route;
  if (window.location.hash !== formatRoute(initial)) writeLocationRoute(initial, "replace", { immediate: true });
  // Back, Forward or a typed hash. An editor that is not in the URL cannot be part of that state.
  onLocationRouteChange((route) => {
    if (!sameRoute(route, useNavStore.getState().route)) useNavStore.setState({ ...routeFields(route), transientEditor: null });
  });
}

// Connection / update tracking store
interface ConnectionStore {
  wsConnected: boolean;
  lastDataAt: number | null;
  dataSource: "ws" | "poll" | null;
  setWsConnected: (connected: boolean) => void;
  recordDataReceived: (source: "ws" | "poll") => void;
}

export const useConnectionStore = create<ConnectionStore>((set) => ({
  wsConnected: false,
  lastDataAt: null,
  dataSource: null,
  setWsConnected: (connected) => set({ wsConnected: connected }),
  recordDataReceived: (source) => set({ lastDataAt: Date.now(), dataSource: source }),
}));
