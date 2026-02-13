/**
 * Backend adapter — routes calls to either Tauri commands (desktop) or HTTP API (web).
 * Detection: window.__TAURI__ is injected by Tauri runtime.
 */

const isTauri = () => typeof window !== "undefined" && !!(window as any).__TAURI__;

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

// ── HTTP helpers (existing web mode) ─────────────────────────────────

const BASE = "/api";

async function httpRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Request failed: ${res.status}`);
  }
  return res.json();
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
  async getServices() {
    if (isTauri()) {
      const services = await tauriCall<any[]>("get_services");
      return { services, count: services.length };
    }
    return httpRequest("/services/");
  },

  async getServiceDetail(label: string) {
    if (isTauri()) return tauriCall("get_service_detail", { label });
    return httpRequest(`/services/${label}`);
  },

  async manageService(label: string, action: string, plistPath?: string) {
    if (isTauri()) {
      return tauriCall("manage_service", {
        label,
        action,
        plistPath: plistPath || null,
      });
    }
    return httpRequest(`/services/${label}/${action}`, {
      method: "POST",
      body: plistPath ? JSON.stringify({ plistPath }) : undefined,
    });
  },

  // Processes
  async getProcesses(sort?: string, limit?: number, search?: string) {
    if (isTauri()) {
      let procs = await tauriCall<any[]>("get_processes");
      if (search) {
        const q = search.toLowerCase();
        procs = procs.filter(
          (p: any) =>
            p.command.toLowerCase().includes(q) ||
            p.args.toLowerCase().includes(q) ||
            p.path.toLowerCase().includes(q) ||
            String(p.pid).includes(q)
        );
      }
      // Sort
      const s = sort || "cpu";
      procs.sort((a: any, b: any) => {
        switch (s) {
          case "cpu": return b.cpu - a.cpu;
          case "mem": return b.mem - a.mem;
          case "pid": return a.pid - b.pid;
          case "name": return a.command.localeCompare(b.command);
          default: return 0;
        }
      });
      const sliced = procs.slice(0, limit || 200);
      return { processes: sliced, total: procs.length, filtered: sliced.length };
    }
    const params = new URLSearchParams();
    if (sort) params.set("sort", sort);
    if (limit) params.set("limit", String(limit));
    if (search) params.set("search", search);
    return httpRequest(`/processes/?${params}`);
  },

  async killProcess(pid: number, force = false) {
    if (isTauri()) return tauriCall("kill_process", { pid, force });
    return httpRequest(`/processes/${pid}/kill`, {
      method: "POST",
      body: JSON.stringify({ force }),
    });
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
