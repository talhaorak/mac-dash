import { create } from "zustand";

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
  category: string;
  plistPath: string | null;
  program: string | null;
  programArguments: string[] | null;
  runAtLoad: boolean | null;
  enabled: boolean;
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
  addEntry: (entry: LogEntry) => void;
  setEntries: (entries: LogEntry[]) => void;
  setPaused: (paused: boolean) => void;
  clear: () => void;
}

export const useLogsStore = create<LogsStore>((set, get) => ({
  entries: [],
  paused: false,
  maxEntries: 500,
  addEntry: (entry) => {
    if (get().paused) return;
    set((state) => ({
      entries: [...state.entries.slice(-(state.maxEntries - 1)), entry],
    }));
  },
  setEntries: (entries) => set({ entries }),
  setPaused: (paused) => set({ paused }),
  clear: () => set({ entries: [] }),
}));

// Navigation store
interface NavStore {
  currentPage: string;
  sidebarCollapsed: boolean;
  logProcessFilter: string | null;
  targetProcessPid: number | null;
  targetServiceLabel: string | null;
  setPage: (page: string) => void;
  toggleSidebar: () => void;
  navigateToLogs: (processName?: string) => void;
  navigateToProcess: (pid: number) => void;
  navigateToService: (label: string) => void;
}

export const useNavStore = create<NavStore>((set) => ({
  currentPage: "dashboard",
  sidebarCollapsed: false,
  logProcessFilter: null,
  targetProcessPid: null,
  targetServiceLabel: null,
  setPage: (page) => set({ currentPage: page, logProcessFilter: null, targetProcessPid: null, targetServiceLabel: null }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  navigateToLogs: (processName) =>
    set({ currentPage: "logs", logProcessFilter: processName || null }),
  navigateToProcess: (pid) =>
    set({ currentPage: "processes", targetProcessPid: pid, targetServiceLabel: null }),
  navigateToService: (label) =>
    set({ currentPage: "services", targetServiceLabel: label, targetProcessPid: null }),
}));

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
