import { useSystemStore, useServicesStore, useProcessesStore, useLogsStore } from "@/stores/app";
import { GlowCard } from "@/components/ui/GlowCard";
import { Gauge } from "@/components/ui/Gauge";
import { MiniChart } from "@/components/ui/MiniChart";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { formatBytes, formatNumber } from "@/lib/utils";
import {
  Cpu,
  HardDrive,
  MemoryStick,
  Clock,
  Server,
  Activity,
  ScrollText,
  Layers,
} from "lucide-react";
import { motion } from "framer-motion";
import { useNavStore } from "@/stores/app";
import { useT } from "@/i18n";

export function DashboardPage() {
  const { t, tn } = useT();
  const stats = useSystemStore((s) => s.stats);
  const history = useSystemStore((s) => s.history);
  const services = useServicesStore((s) => s.services);
  const processes = useProcessesStore((s) => s.processes);
  const logEntries = useLogsStore((s) => s.entries);
  const setPage = useNavStore((s) => s.setPage);

  const cpuUsed = stats ? stats.cpu.user + stats.cpu.sys : 0;
  const memPercent = stats?.memory.usedPercent ?? 0;
  const diskPercent = stats?.disk.usedPercent ?? 0;

  const runningServices = services.filter((s) => s.status === "running").length;
  const stoppedServices = services.filter((s) => s.status === "stopped").length;
  const errorServices = services.filter((s) => s.status === "error").length;

  const topProcesses = [...processes].sort((a, b) => b.cpu - a.cpu).slice(0, 5);
  const recentLogs = logEntries.slice(-8);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">{t("pages.dashboard.title")}</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {t("pages.dashboard.subtitle", {
              hostname: stats?.hostname ?? "...",
              osVersion: stats?.osVersion ?? "...",
              uptime: stats?.uptime ?? "...",
            })}
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <div className="w-1.5 h-1.5 rounded-full bg-green-500 status-pulse" />
          {t("pages.dashboard.live")}
        </div>
      </div>

      {/* Gauges row */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <GlowCard glow="accent" className="flex items-center gap-6">
          <Gauge value={cpuUsed} label={t("pages.dashboard.cpu")} sublabel={stats?.cpu.model?.split(" ").slice(0, 2).join(" ")} color="#06b6d4" />
          <div className="flex-1 space-y-2">
            <MiniChart data={history.map((h) => ({ value: h.cpu }))} color="#06b6d4" label={t("pages.dashboard.cpuHistoryLabel")} />
            <div className="grid grid-cols-2 gap-x-4 text-xs">
              <div className="text-gray-500">{t("pages.dashboard.cpuUser")}</div>
              <div className="text-right text-cyan-400 font-mono">{stats?.cpu.user.toFixed(1)}%</div>
              <div className="text-gray-500">{t("pages.dashboard.cpuSystem")}</div>
              <div className="text-right text-cyan-400 font-mono">{stats?.cpu.sys.toFixed(1)}%</div>
              <div className="text-gray-500">{t("pages.dashboard.cpuCores")}</div>
              <div className="text-right text-gray-300 font-mono">{stats?.cpu.cores}</div>
            </div>
          </div>
        </GlowCard>

        <GlowCard glow={memPercent > 85 ? "danger" : "none"} className="flex items-center gap-6">
          <Gauge value={memPercent} label={t("pages.dashboard.memory")} sublabel={stats ? formatBytes(stats.memory.total) : ""} color={memPercent > 85 ? "#ef4444" : "#8b5cf6"} />
          <div className="flex-1 space-y-2">
            <MiniChart data={history.map((h) => ({ value: h.mem }))} color="#8b5cf6" label={t("pages.dashboard.memoryHistoryLabel")} />
            <div className="grid grid-cols-2 gap-x-4 text-xs">
              <div className="text-gray-500">{t("pages.dashboard.memoryUsed")}</div>
              <div className="text-right text-purple-400 font-mono">{stats ? formatBytes(stats.memory.used) : "-"}</div>
              <div className="text-gray-500">{t("pages.dashboard.memoryWired")}</div>
              <div className="text-right text-purple-400 font-mono">{stats ? formatBytes(stats.memory.wired) : "-"}</div>
              <div className="text-gray-500">{t("pages.dashboard.memoryCompressed")}</div>
              <div className="text-right text-gray-300 font-mono">{stats ? formatBytes(stats.memory.compressed) : "-"}</div>
            </div>
          </div>
        </GlowCard>

        <GlowCard glow={diskPercent > 90 ? "danger" : "none"} className="flex items-center gap-6">
          <Gauge value={diskPercent} label={t("pages.dashboard.disk")} sublabel={stats ? formatBytes(stats.disk.total) : ""} color={diskPercent > 90 ? "#ef4444" : "#22c55e"} />
          <div className="flex-1 space-y-3">
            {/* Disk bar */}
            <div className="space-y-1">
              <div className="h-2 rounded-full bg-white/[0.06] overflow-hidden">
                <motion.div
                  className="h-full rounded-full bg-gradient-to-r from-green-500 to-emerald-400"
                  initial={{ width: 0 }}
                  animate={{ width: `${diskPercent}%` }}
                  transition={{ duration: 0.8 }}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-x-4 text-xs">
              <div className="text-gray-500">{t("pages.dashboard.diskUsed")}</div>
              <div className="text-right text-green-400 font-mono whitespace-nowrap">{stats ? formatBytes(stats.disk.used) : "-"}</div>
              <div className="text-gray-500">{t("pages.dashboard.diskFree")}</div>
              <div className="text-right text-green-400 font-mono whitespace-nowrap">{stats ? formatBytes(stats.disk.free) : "-"}</div>
              <div className="text-gray-500">{t("pages.dashboard.diskMount")}</div>
              <div className="text-right text-gray-300 font-mono">/</div>
            </div>
          </div>
        </GlowCard>
      </div>

      {/* Stats cards row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <GlowCard hover onClick={() => setPage("services")} padding="sm">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-cyan-500/10 flex items-center justify-center">
              <Server className="w-5 h-5 text-cyan-400" />
            </div>
            <div>
              <div className="text-2xl font-bold text-white font-mono">{services.length}</div>
              <div className="text-xs text-gray-500">{t("pages.dashboard.services")}</div>
            </div>
          </div>
          <div className="flex gap-3 mt-3 text-xs">
            <span className="text-green-400">{tn("pages.dashboard.runningCount", runningServices)}</span>
            <span className="text-gray-500">{tn("pages.dashboard.stoppedCount", stoppedServices)}</span>
            {errorServices > 0 && <span className="text-red-400">{tn("pages.dashboard.errorCount", errorServices)}</span>}
          </div>
        </GlowCard>

        <GlowCard hover onClick={() => setPage("processes")} padding="sm">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-purple-500/10 flex items-center justify-center">
              <Activity className="w-5 h-5 text-purple-400" />
            </div>
            <div>
              <div className="text-2xl font-bold text-white font-mono">{processes.length || stats?.processCount || 0}</div>
              <div className="text-xs text-gray-500">{t("pages.dashboard.processesLabel")}</div>
            </div>
          </div>
          <div className="flex gap-3 mt-3 text-xs">
            <span className="text-purple-400">{t("pages.dashboard.sortedByCpu")}</span>
          </div>
        </GlowCard>

        <GlowCard padding="sm">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-amber-500/10 flex items-center justify-center">
              <Layers className="w-5 h-5 text-amber-400" />
            </div>
            <div>
              <div className="text-2xl font-bold text-white font-mono">
                {stats?.cpu.loadAvg[0].toFixed(1) ?? "-"}
              </div>
              <div className="text-xs text-gray-500">{t("pages.dashboard.loadAvg")}</div>
            </div>
          </div>
          <div className="flex gap-3 mt-3 text-xs text-gray-500 font-mono">
            <span>{stats?.cpu.loadAvg[0].toFixed(2)}</span>
            <span>{stats?.cpu.loadAvg[1].toFixed(2)}</span>
            <span>{stats?.cpu.loadAvg[2].toFixed(2)}</span>
          </div>
        </GlowCard>

        <GlowCard hover onClick={() => setPage("logs")} padding="sm">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-500/10 flex items-center justify-center">
              <ScrollText className="w-5 h-5 text-emerald-400" />
            </div>
            <div>
              <div className="text-2xl font-bold text-white font-mono">{logEntries.length}</div>
              <div className="text-xs text-gray-500">{t("pages.dashboard.logEntriesLabel")}</div>
            </div>
          </div>
          <div className="flex gap-3 mt-3 text-xs">
            <span className="text-red-400">{tn("pages.dashboard.logErrorsCount", logEntries.filter(l => l.level === "error").length)}</span>
            <span className="text-amber-400">{tn("pages.dashboard.logWarningsCount", logEntries.filter(l => l.level === "warning").length)}</span>
          </div>
        </GlowCard>
      </div>

      {/* Bottom row: Top Processes + Recent Logs */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Top Processes */}
        <GlowCard>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-gray-300">{t("pages.dashboard.topProcessesTitle")}</h3>
            <button
              onClick={() => setPage("processes")}
              className="text-xs text-cyan-400 hover:text-cyan-300 transition-colors"
            >
              {t("pages.dashboard.viewAll")}
            </button>
          </div>
          <div className="space-y-2">
            {topProcesses.map((proc, i) => (
              <div
                key={proc.pid}
                className="flex items-center gap-3 text-xs py-1.5 px-2 rounded-lg hover:bg-white/[0.03] transition-colors"
              >
                <span className="w-4 text-gray-600 font-mono">{i + 1}</span>
                <span className="flex-1 text-gray-300 truncate font-mono" title={proc.args}>
                  {proc.command.split("/").pop()}
                </span>
                <span className="text-cyan-400 font-mono w-14 text-right">
                  {proc.cpu.toFixed(1)}%
                </span>
                <div className="w-16 h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
                  <div
                    className="h-full rounded-full bg-cyan-500"
                    style={{ width: `${Math.min(proc.cpu, 100)}%` }}
                  />
                </div>
              </div>
            ))}
            {topProcesses.length === 0 && (
              <div className="text-center text-gray-600 text-xs py-4">{t("pages.dashboard.waitingForData")}</div>
            )}
          </div>
        </GlowCard>

        {/* Recent Logs */}
        <GlowCard>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-gray-300">{t("pages.dashboard.recentLogsTitle")}</h3>
            <button
              onClick={() => setPage("logs")}
              className="text-xs text-cyan-400 hover:text-cyan-300 transition-colors"
            >
              {t("pages.dashboard.viewAll")}
            </button>
          </div>
          <div className="space-y-1 font-mono text-[11px]">
            {recentLogs.map((log, i) => (
              <div
                key={i}
                className="flex gap-2 py-1 px-2 rounded hover:bg-white/[0.03] transition-colors truncate"
              >
                <span
                  className={
                    log.level === "error"
                      ? "text-red-400"
                      : log.level === "warning"
                      ? "text-amber-400"
                      : log.level === "info"
                      ? "text-cyan-400"
                      : "text-gray-600"
                  }
                >
                  {log.level.slice(0, 3).toUpperCase()}
                </span>
                <span className="text-gray-500">{log.process}</span>
                <span className="text-gray-400 truncate flex-1">{log.message}</span>
              </div>
            ))}
            {recentLogs.length === 0 && (
              <div className="text-center text-gray-600 text-xs py-4">{t("pages.dashboard.waitingForLogs")}</div>
            )}
          </div>
        </GlowCard>
      </div>
    </div>
  );
}
