/**
 * Backend adapter — routes calls to either Tauri commands (desktop) or the HTTP API (web).
 * Both backends implement docs/backend-contract.md.
 */

import type { JobCategory, PathFacts } from "@shared/launchd";
import type { ServiceInfo } from "@/stores/app";

const isTauri = () =>
  typeof window !== "undefined" &&
  (!!((window as any).__TAURI__) || !!((window as any).__TAURI_INTERNALS__));

let tauriInvoke: ((cmd: string, args?: any) => Promise<any>) | null = null;

async function getInvoke() {
  if (tauriInvoke) return tauriInvoke;
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    tauriInvoke = invoke;
    return invoke;
  }
  return null;
}

async function tauriCall<T>(cmd: string, args?: Record<string, any>): Promise<T> {
  const invoke = await getInvoke();
  if (!invoke) throw new Error("Not in Tauri context");
  const result = await invoke(cmd, args);
  // Our Rust commands wrap in { ok, data, error }
  if (result && typeof result === "object" && "ok" in result) {
    if (!result.ok) throw new Error(result.error || "Command failed");
    return result.data as T;
  }
  return result as T;
}

// ── HTTP helpers (web mode) ──────────────────────────────────────────

const BASE = "/api";

async function httpRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || (body && body.ok === false)) {
    throw new Error(body?.error || `Request failed: ${res.status} ${res.statusText}`);
  }
  return body as T;
}

const post = <T>(path: string, body?: unknown) =>
  httpRequest<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

const jobQuery = (ref: JobRef, extra?: Record<string, string>) =>
  new URLSearchParams({ label: ref.label, category: ref.category, ...extra }).toString();

// ── Types (docs/backend-contract.md) ─────────────────────────────────

export interface JobRef {
  label: string;
  category: JobCategory;
}

export type ServiceAction = "start" | "stop" | "restart" | "load" | "unload" | "enable" | "disable";

export interface ServiceDetail {
  path: string | null;
  type: string | null;
  bundleId: string | null;
  state: string | null;
  environment: Record<string, string>;
  lastExitReason: string | null;
  domain: string;
  raw: string;
}

export interface JobDocument extends JobRef {
  path: string;
  fileName: string;
  xml: string;
  writable: boolean;
  needsAdmin: boolean;
  mtime: number;
}

export interface SaveJobRequest {
  category: JobCategory;
  xml: string;
  original?: JobRef | null;
  load?: boolean;
}

export interface JobOutput {
  path: string | null;
  exists: boolean;
  size: number;
  truncated: boolean;
  text: string;
}

export interface JobEvent extends JobRef {
  id: string;
  at: number;
  kind: "added" | "modified" | "removed";
  path: string;
  program: string | null;
}

export interface JobMeta {
  notes: string;
  tags: string[];
}

export interface JobRevision {
  id: string;
  at: number;
  size: number;
}

export interface StartupExtras {
  cron: string[];
  helperTools: { name: string; path: string }[];
  startupItems: { name: string; path: string }[];
}

export interface LoginItem {
  name: string;
  path: string;
  hidden: boolean;
}

export const metaKey = (ref: JobRef) => `${ref.category}/${ref.label}`;

export interface ProcessChainEntry {
  pid: number;
  ppid: number;
  user: string;
  command: string;
}

export interface ProcessDetail {
  cwd: string | null;
  parentChain: ProcessChainEntry[];
  [key: string]: unknown;
}

// ── Unified Backend API ──────────────────────────────────────────────

export const backend = {
  isDesktop: isTauri,

  // System
  async getSystemStats() {
    if (isTauri()) return tauriCall("get_system_info");
    return httpRequest("/system/stats");
  },

  async getHardwareInfo() {
    if (isTauri()) return tauriCall("get_hardware_info");
    return httpRequest("/system/hardware");
  },

  // Services
  async getServices(): Promise<{ services: ServiceInfo[]; count: number }> {
    if (isTauri()) {
      const services = await tauriCall<ServiceInfo[]>("get_services");
      return { services, count: services.length };
    }
    return httpRequest("/services");
  },

  async getServiceDetail(ref: JobRef): Promise<ServiceDetail | null> {
    if (isTauri()) return tauriCall("get_service_detail", { ...ref });
    return httpRequest<ServiceDetail>(`/services/detail?${jobQuery(ref)}`).catch(() => null);
  },

  async manageService(ref: JobRef, action: ServiceAction): Promise<void> {
    if (isTauri()) return tauriCall("manage_service", { ...ref, action });
    await post("/services/action", { ...ref, action });
  },

  // launchd job documents
  async readJob(ref: JobRef): Promise<JobDocument> {
    if (isTauri()) {
      const doc = await tauriCall<JobDocument | null>("read_job", { ...ref });
      if (!doc) throw new Error("Job file not found or not readable");
      return doc;
    }
    return httpRequest(`/services/job?${jobQuery(ref)}`);
  },

  async saveJob(request: SaveJobRequest): Promise<{ label: string; path: string }> {
    if (isTauri()) return tauriCall("save_job", { request });
    return post("/services/job", request);
  },

  async deleteJob(ref: JobRef): Promise<void> {
    if (isTauri()) return tauriCall("delete_job", { ...ref });
    await httpRequest(`/services/job?${jobQuery(ref)}`, { method: "DELETE" });
  },

  async readJobOutput(ref: JobRef, stream: "stdout" | "stderr", lines = 200): Promise<JobOutput> {
    if (isTauri()) return tauriCall("read_job_output", { ...ref, stream, lines });
    return httpRequest(`/services/output?${jobQuery(ref, { stream, lines: String(lines) })}`);
  },

  async checkPaths(paths: string[]): Promise<PathFacts[]> {
    if (paths.length === 0) return [];
    if (isTauri()) return tauriCall("check_paths", { paths });
    return (await post<{ facts: PathFacts[] }>("/services/check-paths", { paths })).facts;
  },

  async revealJob(ref: JobRef): Promise<void> {
    if (isTauri()) return tauriCall("reveal_job", { ...ref });
    await post("/services/reveal", ref);
  },

  // Notes, tags, revisions
  async getJobMeta(): Promise<Record<string, JobMeta>> {
    if (isTauri()) return tauriCall("get_job_meta");
    return (await httpRequest<{ meta: Record<string, JobMeta> }>("/services/meta")).meta;
  },

  async setJobMeta(ref: JobRef, meta: JobMeta): Promise<void> {
    if (isTauri()) return tauriCall("set_job_meta", { ...ref, ...meta });
    await httpRequest("/services/meta", { method: "PUT", body: JSON.stringify({ ...ref, ...meta }) });
  },

  async listJobRevisions(label: string): Promise<JobRevision[]> {
    if (isTauri()) return tauriCall("list_job_revisions", { label });
    return (await httpRequest<{ revisions: JobRevision[] }>(`/services/revisions?${new URLSearchParams({ label })}`)).revisions;
  },

  async readJobRevision(id: string): Promise<string> {
    if (isTauri()) return tauriCall("read_job_revision", { id });
    return (await httpRequest<{ xml: string }>(`/services/revision?${new URLSearchParams({ id })}`)).xml;
  },

  // Startup mechanisms that are not launchd plists
  async getStartupExtras(): Promise<StartupExtras> {
    if (isTauri()) return tauriCall("get_startup_extras");
    return httpRequest("/services/extras");
  },

  /** macOS asks for Automation permission on the first call. Only call this on user request. */
  async getLoginItems(): Promise<LoginItem[]> {
    if (isTauri()) return tauriCall("get_login_items");
    return (await httpRequest<{ items: LoginItem[] }>("/services/login-items")).items;
  },

  async listShortcuts(): Promise<string[]> {
    if (isTauri()) return tauriCall("list_shortcuts");
    return (await httpRequest<{ shortcuts: string[] }>("/services/shortcuts")).shortcuts;
  },

  async getJobEvents(): Promise<JobEvent[]> {
    if (isTauri()) return tauriCall("get_job_events");
    return (await httpRequest<{ events: JobEvent[] }>("/services/events")).events;
  },

  async clearJobEvents(): Promise<void> {
    if (isTauri()) return tauriCall("clear_job_events");
    await httpRequest("/services/events", { method: "DELETE" });
  },

  /** Desktop only: job changes arrive as Tauri events. The web build gets them on the "job-events" WS topic. */
  async onJobEvent(handler: (event: JobEvent) => void): Promise<() => void> {
    if (!isTauri()) return () => {};
    const { listen } = await import("@tauri-apps/api/event");
    return listen<JobEvent>("job-event", (e) => handler(e.payload));
  },

  // Processes
  async getProcesses(sort?: string, limit?: number, search?: string) {
    if (isTauri()) {
      return tauriCall("get_processes", { sort: sort ?? null, limit: limit ?? null, search: search ?? null });
    }
    const params = new URLSearchParams();
    if (sort) params.set("sort", sort);
    if (limit) params.set("limit", String(limit));
    if (search) params.set("search", search);
    return httpRequest(`/processes/?${params}`);
  },

  async getProcessDetail(pid: number): Promise<ProcessDetail> {
    if (isTauri()) return tauriCall("get_process_detail", { pid });
    return httpRequest(`/processes/${pid}`);
  },

  async killProcess(pid: number, force = false) {
    if (isTauri()) return tauriCall("kill_process", { pid, force });
    return post(`/processes/${pid}/kill`, { force });
  },

  // Logs
  async startLogStream() {
    if (isTauri()) return tauriCall("start_log_stream");
    // Web mode uses WebSocket, no explicit start needed
  },

  async stopLogStream() {
    if (isTauri()) return tauriCall("stop_log_stream");
  },

  async getRecentLogs(count = 100, process?: string) {
    if (isTauri()) {
      let logs = await tauriCall<any[]>("get_recent_logs", { count });
      if (process) {
        const q = process.toLowerCase();
        logs = logs.filter((l: any) => l.process.toLowerCase().includes(q));
      }
      return { logs, count: logs.length };
    }
    const params = new URLSearchParams({ count: String(count) });
    if (process) params.set("process", process);
    return httpRequest(`/logs/recent?${params}`);
  },

  async queryLogs(minutes = 5, predicate?: string) {
    if (isTauri()) return tauriCall("query_logs", { minutes, predicate: predicate || null });
    const params = new URLSearchParams({ minutes: String(minutes) });
    if (predicate) params.set("predicate", predicate);
    return httpRequest(`/logs/query?${params}`);
  },

  async getActiveLogProcesses() {
    if (isTauri()) return tauriCall("get_active_log_processes");
    return httpRequest("/logs/active-processes");
  },
};
