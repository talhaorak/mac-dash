import { useState, useMemo, useEffect, useCallback } from "react";
import {
  useProcessesStore,
  useServicesStore,
  useNavStore,
  type ProcessInfo,
} from "@/stores/app";
import { GlowCard } from "@/components/ui/GlowCard";
import { CopyButton } from "@/components/ui/CopyButton";
import { api } from "@/lib/api";
import { cn, formatBytes } from "@/lib/utils";
import {
  Search,
  ArrowUpDown,
  Skull,
  ChevronUp,
  ChevronDown,
  AlertTriangle,
  X,
  Terminal,
  User,
  Clock,
  Cpu,
  MemoryStick,
  ScrollText,
  FolderOpen,
  GitBranch,
  Loader2,
  ArrowLeft,
  Cog,
  ExternalLink,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

type SortField = "cpu" | "mem" | "pid" | "name" | "rss";
type SortDir = "asc" | "desc";

interface ProcessChainEntry {
  pid: number;
  ppid: number;
  user: string;
  command: string;
}

interface ProcessExtended {
  cwd: string | null;
  parentChain: ProcessChainEntry[];
}

interface ProcessHistoryEntry {
  process: ProcessInfo;
  extended: ProcessExtended | null;
}

export function ProcessesPage() {
  const processes = useProcessesStore((s) => s.processes);
  const services = useServicesStore((s) => s.services);
  const navigateToLogs = useNavStore((s) => s.navigateToLogs);
  const navigateToService = useNavStore((s) => s.navigateToService);
  const targetProcessPid = useNavStore((s) => s.targetProcessPid);
  const [search, setSearch] = useState("");
  const [sortField, setSortField] = useState<SortField>("cpu");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [selectedProcess, setSelectedProcess] = useState<ProcessInfo | null>(
    null
  );
  const [killConfirm, setKillConfirm] = useState<number | null>(null);
  const [extendedInfo, setExtendedInfo] = useState<ProcessExtended | null>(
    null
  );
  const [loadingExtended, setLoadingExtended] = useState(false);
  const [processHistory, setProcessHistory] = useState<ProcessHistoryEntry[]>(
    []
  );

  // Handle navigation from other pages (e.g. services)
  useEffect(() => {
    if (targetProcessPid && processes.length > 0) {
      const proc = processes.find((p) => p.pid === targetProcessPid);
      if (proc) {
        setSelectedProcess(proc);
      }
    }
  }, [targetProcessPid, processes]);

  // Fetch extended info when a process is selected
  useEffect(() => {
    if (!selectedProcess) {
      setExtendedInfo(null);
      return;
    }
    setLoadingExtended(true);
    api
      .get<ProcessExtended & ProcessInfo>(
        `/processes/${selectedProcess.pid}`
      )
      .then((data) => {
        setExtendedInfo({
          cwd: data.cwd ?? null,
          parentChain: data.parentChain ?? [],
        });
      })
      .catch(() => setExtendedInfo(null))
      .finally(() => setLoadingExtended(false));
  }, [selectedProcess?.pid]);

  // Find matching service for current process
  const matchingService = useMemo(() => {
    if (!selectedProcess) return null;
    return services.find(
      (s) =>
        s.pid === selectedProcess.pid ||
        (s.program &&
          selectedProcess.path &&
          s.program === selectedProcess.path)
    );
  }, [selectedProcess, services]);

  // Navigate to a process in the chain
  const navigateToChainProcess = useCallback(
    (chainEntry: ProcessChainEntry) => {
      if (!selectedProcess) return;
      // Save current state in history
      setProcessHistory((prev) => [
        ...prev,
        { process: selectedProcess, extended: extendedInfo },
      ]);
      // Find this process in the list or create a minimal placeholder
      const existing = processes.find((p) => p.pid === chainEntry.pid);
      if (existing) {
        setSelectedProcess(existing);
      } else {
        // Create a temporary ProcessInfo from chain entry
        setSelectedProcess({
          pid: chainEntry.pid,
          ppid: chainEntry.ppid,
          uid: 0,
          user: chainEntry.user,
          cpu: 0,
          mem: 0,
          rss: 0,
          elapsed: "",
          command: chainEntry.command,
          path: "",
          args: "",
        });
      }
    },
    [selectedProcess, extendedInfo, processes]
  );

  // Go back in process history
  const goBack = useCallback(() => {
    setProcessHistory((prev) => {
      const newHistory = [...prev];
      const last = newHistory.pop();
      if (last) {
        setSelectedProcess(last.process);
        setExtendedInfo(last.extended);
      }
      return newHistory;
    });
  }, []);

  const closeModal = useCallback(() => {
    setSelectedProcess(null);
    setProcessHistory([]);
    setExtendedInfo(null);
  }, []);

  const sorted = useMemo(() => {
    let result = processes;
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(
        (p) =>
          p.command.toLowerCase().includes(q) ||
          p.args.toLowerCase().includes(q) ||
          p.path.toLowerCase().includes(q) ||
          p.user.toLowerCase().includes(q) ||
          String(p.pid).includes(q)
      );
    }

    result = [...result].sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case "cpu":
          cmp = a.cpu - b.cpu;
          break;
        case "mem":
          cmp = a.mem - b.mem;
          break;
        case "pid":
          cmp = a.pid - b.pid;
          break;
        case "rss":
          cmp = a.rss - b.rss;
          break;
        case "name":
          cmp = a.command.localeCompare(b.command);
          break;
      }
      return sortDir === "desc" ? -cmp : cmp;
    });

    return result;
  }, [processes, search, sortField, sortDir]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir(sortDir === "desc" ? "asc" : "desc");
    } else {
      setSortField(field);
      setSortDir("desc");
    }
  };

  const handleKill = async (pid: number, force = false) => {
    try {
      await api.post(`/processes/${pid}/kill`, { force });
      setKillConfirm(null);
    } catch (e: any) {
      console.error("Kill failed:", e.message);
    }
  };

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field)
      return <ArrowUpDown className="w-3 h-3 text-gray-600" />;
    return sortDir === "desc" ? (
      <ChevronDown className="w-3 h-3 text-cyan-400" />
    ) : (
      <ChevronUp className="w-3 h-3 text-cyan-400" />
    );
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Processes</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {processes.length} processes &middot; showing {sorted.length}
          </p>
        </div>
      </div>

      {/* Search */}
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
        <input
          type="text"
          placeholder="Search by name, PID, path, args, user..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full pl-9 pr-4 py-2 rounded-xl bg-white/[0.04] border border-white/[0.06] text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/20 transition-all"
        />
      </div>

      {/* Table */}
      <GlowCard padding="sm">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-white/[0.06]">
                {[
                  { field: "pid" as SortField, label: "PID", w: "w-16" },
                  { field: "name" as SortField, label: "Name", w: "flex-1" },
                  { field: "cpu" as SortField, label: "CPU %", w: "w-24" },
                  { field: "mem" as SortField, label: "MEM %", w: "w-24" },
                  { field: "rss" as SortField, label: "RSS", w: "w-20" },
                ].map(({ field, label, w }) => (
                  <th
                    key={field}
                    className={cn(
                      "text-left py-2.5 px-3 text-gray-500 font-medium cursor-pointer hover:text-gray-300 transition-colors select-none",
                      w
                    )}
                    onClick={() => handleSort(field)}
                  >
                    <span className="inline-flex items-center gap-1">
                      {label}
                      <SortIcon field={field} />
                    </span>
                  </th>
                ))}
                <th className="text-left py-2.5 px-3 text-gray-500 font-medium">
                  User
                </th>
                <th className="text-left py-2.5 px-3 text-gray-500 font-medium">
                  Time
                </th>
                <th className="py-2.5 px-3 w-20"></th>
              </tr>
            </thead>
            <tbody>
              {sorted.slice(0, 150).map((proc) => {
                const isHot = proc.cpu > 50;
                const isWarm = proc.cpu > 20;
                return (
                  <tr
                    key={proc.pid}
                    className={cn(
                      "border-b border-white/[0.03] hover:bg-white/[0.03] transition-colors cursor-pointer group",
                      isHot && "bg-red-500/[0.03]"
                    )}
                    onClick={() => {
                      setProcessHistory([]);
                      setSelectedProcess(proc);
                    }}
                  >
                    <td className="py-2 px-3 font-mono text-gray-500">
                      {proc.pid}
                    </td>
                    <td className="py-2 px-3">
                      <div
                        className="text-gray-200 font-mono truncate max-w-xs"
                        title={proc.path || proc.command}
                      >
                        {proc.command}
                      </div>
                    </td>
                    <td className="py-2 px-3">
                      <div className="flex items-center gap-2">
                        <div className="w-12 h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
                          <div
                            className={cn(
                              "h-full rounded-full transition-all",
                              isHot
                                ? "bg-red-500"
                                : isWarm
                                ? "bg-amber-500"
                                : "bg-cyan-500"
                            )}
                            style={{
                              width: `${Math.min(proc.cpu, 100)}%`,
                            }}
                          />
                        </div>
                        <span
                          className={cn(
                            "font-mono",
                            isHot
                              ? "text-red-400"
                              : isWarm
                              ? "text-amber-400"
                              : "text-gray-400"
                          )}
                        >
                          {proc.cpu.toFixed(1)}
                        </span>
                      </div>
                    </td>
                    <td className="py-2 px-3">
                      <div className="flex items-center gap-2">
                        <div className="w-12 h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
                          <div
                            className="h-full rounded-full bg-purple-500 transition-all"
                            style={{
                              width: `${Math.min(proc.mem, 100)}%`,
                            }}
                          />
                        </div>
                        <span className="font-mono text-gray-400">
                          {proc.mem.toFixed(1)}
                        </span>
                      </div>
                    </td>
                    <td className="py-2 px-3 font-mono text-gray-500">
                      {formatBytes(proc.rss * 1024)}
                    </td>
                    <td className="py-2 px-3 text-gray-500">{proc.user}</td>
                    <td className="py-2 px-3 text-gray-600 font-mono">
                      {proc.elapsed}
                    </td>
                    <td className="py-2 px-3">
                      <div className="flex items-center gap-1">
                        {killConfirm === proc.pid ? (
                          <div
                            className="flex gap-1"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <button
                              onClick={() => handleKill(proc.pid)}
                              className="px-2 py-1 rounded bg-red-500/20 text-red-400 hover:bg-red-500/30 text-[10px] font-medium"
                            >
                              TERM
                            </button>
                            <button
                              onClick={() => handleKill(proc.pid, true)}
                              className="px-2 py-1 rounded bg-red-500/30 text-red-300 hover:bg-red-500/40 text-[10px] font-medium"
                            >
                              KILL
                            </button>
                            <button
                              onClick={() => setKillConfirm(null)}
                              className="px-1 py-1 rounded text-gray-500 hover:text-gray-300"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </div>
                        ) : (
                          <>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                navigateToLogs(proc.command);
                              }}
                              className="p-1.5 rounded-lg opacity-0 group-hover:opacity-100 hover:bg-cyan-500/10 text-gray-600 hover:text-cyan-400 transition-all"
                              title="View Logs"
                            >
                              <ScrollText className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setKillConfirm(proc.pid);
                              }}
                              className="p-1.5 rounded-lg opacity-0 group-hover:opacity-100 hover:bg-red-500/10 text-gray-600 hover:text-red-400 transition-all"
                              title="Kill process"
                            >
                              <Skull className="w-3.5 h-3.5" />
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </GlowCard>

      {/* Process Detail Modal */}
      <AnimatePresence>
        {selectedProcess && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-8"
            onClick={closeModal}
          >
            <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
            <motion.div
              initial={{ scale: 0.95, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.95, y: 20 }}
              className="relative glass rounded-2xl w-full max-w-xl p-6 space-y-4 max-h-[85vh] overflow-y-auto"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Back button (when navigating process chain) */}
              {processHistory.length > 0 && (
                <button
                  onClick={goBack}
                  className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium text-cyan-400 hover:bg-cyan-500/10 transition-colors -mt-1 mb-1"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                  Back to {processHistory[processHistory.length - 1].process.command}:
                  {processHistory[processHistory.length - 1].process.pid}
                </button>
              )}

              <div className="flex items-start justify-between">
                <div>
                  <h2 className="text-lg font-bold text-white font-mono">
                    {selectedProcess.command}
                  </h2>
                  <p className="text-xs text-gray-500 mt-0.5">
                    PID {selectedProcess.pid} &middot; PPID{" "}
                    {selectedProcess.ppid}
                  </p>
                </div>
                <button
                  onClick={closeModal}
                  className="p-2 rounded-lg hover:bg-white/[0.06] text-gray-400"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Service link */}
              {matchingService && (
                <button
                  onClick={() => {
                    closeModal();
                    navigateToService(matchingService.label);
                  }}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl bg-purple-500/5 border border-purple-500/20 hover:bg-purple-500/10 transition-colors group"
                >
                  <Cog className="w-4 h-4 text-purple-400 flex-shrink-0" />
                  <div className="flex-1 text-left">
                    <div className="text-xs font-medium text-purple-300">
                      Managed by service
                    </div>
                    <div className="text-[11px] font-mono text-purple-400/70">
                      {matchingService.label}
                    </div>
                  </div>
                  <ExternalLink className="w-3.5 h-3.5 text-purple-400/50 group-hover:text-purple-400 transition-colors" />
                </button>
              )}

              <div className="grid grid-cols-2 gap-3">
                <InfoCard
                  icon={Cpu}
                  label="CPU"
                  value={`${selectedProcess.cpu.toFixed(1)}%`}
                />
                <InfoCard
                  icon={MemoryStick}
                  label="Memory"
                  value={`${selectedProcess.mem.toFixed(1)}% (${formatBytes(
                    selectedProcess.rss * 1024
                  )})`}
                />
                <InfoCard
                  icon={User}
                  label="User"
                  value={selectedProcess.user}
                />
                <InfoCard
                  icon={Clock}
                  label="Elapsed"
                  value={selectedProcess.elapsed || "N/A"}
                />
              </div>

              {/* Executable Path */}
              <InfoBox
                icon={Terminal}
                label="Executable Path"
                value={selectedProcess.path || "N/A"}
              />

              {/* Full Command */}
              <InfoBox
                icon={Terminal}
                label="Full Command"
                value={selectedProcess.args || "N/A"}
                scrollable
              />

              {/* Working Directory */}
              <div className="space-y-1.5 group">
                <div className="text-xs text-gray-500 font-medium flex items-center gap-1.5">
                  <FolderOpen className="w-3.5 h-3.5" />
                  Working Directory
                </div>
                <div className="relative bg-black/30 rounded-lg p-3 font-mono text-xs text-gray-300 break-all">
                  {loadingExtended ? (
                    <span className="flex items-center gap-2 text-gray-600">
                      <Loader2 className="w-3 h-3 animate-spin" /> Loading...
                    </span>
                  ) : extendedInfo?.cwd ? (
                    <>
                      {extendedInfo.cwd}
                      <div className="absolute top-1.5 right-1.5">
                        <CopyButton text={extendedInfo.cwd} />
                      </div>
                    </>
                  ) : (
                    <span className="text-gray-600">N/A</span>
                  )}
                </div>
              </div>

              {/* Parent Chain */}
              <div className="space-y-1.5">
                <div className="text-xs text-gray-500 font-medium flex items-center gap-1.5">
                  <GitBranch className="w-3.5 h-3.5" />
                  Process Chain (who started this)
                </div>
                <div className="bg-black/30 rounded-lg p-3 space-y-1">
                  {loadingExtended ? (
                    <span className="flex items-center gap-2 text-gray-600 text-xs">
                      <Loader2 className="w-3 h-3 animate-spin" /> Loading...
                    </span>
                  ) : extendedInfo?.parentChain &&
                    extendedInfo.parentChain.length > 0 ? (
                    extendedInfo.parentChain.map((entry, i) => (
                      <button
                        key={entry.pid}
                        onClick={() => {
                          if (entry.pid !== selectedProcess.pid) {
                            navigateToChainProcess(entry);
                          }
                        }}
                        disabled={entry.pid === selectedProcess.pid}
                        className={cn(
                          "flex items-center gap-2 text-xs font-mono w-full text-left px-1.5 py-1 rounded-md transition-colors",
                          entry.pid === selectedProcess.pid
                            ? "text-gray-500 cursor-default"
                            : "hover:bg-white/[0.06] cursor-pointer"
                        )}
                      >
                        <span className="text-gray-600 w-4 text-right flex-shrink-0">
                          {i === 0 ? "" : "\u2514\u2500"}
                        </span>
                        <span
                          className={cn(
                            entry.pid === selectedProcess.pid
                              ? "text-gray-500"
                              : "text-cyan-400/70 hover:text-cyan-400"
                          )}
                        >
                          {entry.pid}
                        </span>
                        <span
                          className={cn(
                            entry.pid === selectedProcess.pid
                              ? "text-gray-500"
                              : "text-gray-300"
                          )}
                        >
                          {entry.command}
                        </span>
                        <span className="text-gray-600">({entry.user})</span>
                        {entry.pid !== selectedProcess.pid && (
                          <ExternalLink className="w-3 h-3 text-gray-600 ml-auto flex-shrink-0" />
                        )}
                      </button>
                    ))
                  ) : (
                    <span className="text-gray-600 text-xs">N/A</span>
                  )}
                </div>
              </div>

              {/* Action buttons */}
              <div className="flex justify-between pt-2">
                <button
                  onClick={() => {
                    const name = selectedProcess.command;
                    closeModal();
                    navigateToLogs(name);
                  }}
                  className="px-4 py-2 rounded-xl bg-cyan-500/10 text-cyan-400 hover:bg-cyan-500/20 text-sm font-medium transition-colors flex items-center gap-2"
                >
                  <ScrollText className="w-4 h-4" />
                  View Logs
                </button>
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      handleKill(selectedProcess.pid);
                      closeModal();
                    }}
                    className="px-4 py-2 rounded-xl bg-red-500/10 text-red-400 hover:bg-red-500/20 text-sm font-medium transition-colors flex items-center gap-2"
                  >
                    <Skull className="w-4 h-4" />
                    SIGTERM
                  </button>
                  <button
                    onClick={() => {
                      handleKill(selectedProcess.pid, true);
                      closeModal();
                    }}
                    className="px-4 py-2 rounded-xl bg-red-500/20 text-red-300 hover:bg-red-500/30 text-sm font-medium transition-colors flex items-center gap-2"
                  >
                    <AlertTriangle className="w-4 h-4" />
                    SIGKILL
                  </button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function InfoCard({
  icon: Icon,
  label,
  value,
}: {
  icon: any;
  label: string;
  value: string;
}) {
  return (
    <div className="glass rounded-xl p-3 flex items-center gap-3 group relative">
      <Icon className="w-4 h-4 text-gray-500 flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-[10px] text-gray-500">{label}</div>
        <div className="text-sm text-gray-200 font-mono truncate">{value}</div>
      </div>
      <CopyButton text={value} />
    </div>
  );
}

function InfoBox({
  icon: Icon,
  label,
  value,
  scrollable,
}: {
  icon: any;
  label: string;
  value: string;
  scrollable?: boolean;
}) {
  return (
    <div className="space-y-1.5 group">
      <div className="text-xs text-gray-500 font-medium flex items-center gap-1.5">
        <Icon className="w-3.5 h-3.5" />
        {label}
      </div>
      <div
        className={cn(
          "relative bg-black/30 rounded-lg p-3 font-mono text-xs text-gray-300 break-all",
          scrollable && "max-h-32 overflow-y-auto"
        )}
      >
        {value}
        {value !== "N/A" && (
          <div className="absolute top-1.5 right-1.5">
            <CopyButton text={value} />
          </div>
        )}
      </div>
    </div>
  );
}
