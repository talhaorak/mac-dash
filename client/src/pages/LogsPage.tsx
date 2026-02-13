import { useState, useRef, useEffect, useMemo } from "react";
import { useLogsStore, useNavStore, type LogEntry } from "@/stores/app";
import { GlowCard } from "@/components/ui/GlowCard";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  Search,
  Pause,
  Play,
  Trash2,
  ArrowDown,
  Filter,
  X,
  ChevronDown,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

const levelColors: Record<string, string> = {
  error: "text-red-400 bg-red-500/10",
  warning: "text-amber-400 bg-amber-500/10",
  info: "text-cyan-400 bg-cyan-500/10",
  debug: "text-gray-500 bg-gray-500/10",
  default: "text-gray-400 bg-gray-500/5",
};

const levelBorder: Record<string, string> = {
  error: "border-l-red-500/50",
  warning: "border-l-amber-500/50",
  info: "border-l-cyan-500/30",
  debug: "border-l-gray-600/30",
  default: "border-l-transparent",
};

interface ActiveLogProcess {
  name: string;
  count: number;
  lastSeen: string;
}

export function LogsPage() {
  const entries = useLogsStore((s) => s.entries);
  const paused = useLogsStore((s) => s.paused);
  const setPaused = useLogsStore((s) => s.setPaused);
  const clear = useLogsStore((s) => s.clear);
  const logProcessFilter = useNavStore((s) => s.logProcessFilter);
  const [search, setSearch] = useState("");
  const [levelFilter, setLevelFilter] = useState<Set<string>>(new Set());
  const [processFilter, setProcessFilter] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [newCount, setNewCount] = useState(0);
  const [activeProcesses, setActiveProcesses] = useState<ActiveLogProcess[]>([]);
  const [showProcessPicker, setShowProcessPicker] = useState(false);

  // Apply filter from navigation (e.g. "View Logs" from process page)
  useEffect(() => {
    if (logProcessFilter) {
      setProcessFilter(logProcessFilter);
    }
  }, [logProcessFilter]);

  // Fetch active log processes
  useEffect(() => {
    const fetchProcesses = () => {
      api
        .get<{ processes: ActiveLogProcess[] }>("/logs/active-processes")
        .then((r) => setActiveProcesses(r.processes))
        .catch(() => {});
    };
    fetchProcesses();
    const interval = setInterval(fetchProcesses, 30000); // 30s — active processes list
    return () => clearInterval(interval);
  }, []);

  // Auto-scroll to bottom
  useEffect(() => {
    if (autoScroll && !paused && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      setNewCount(0);
    } else if (paused) {
      setNewCount((c) => c + 1);
    }
  }, [entries.length, autoScroll, paused]);

  const handleScroll = () => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    const atBottom = scrollHeight - scrollTop - clientHeight < 50;
    setAutoScroll(atBottom);
  };

  const scrollToBottom = () => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      setAutoScroll(true);
      setNewCount(0);
    }
  };

  const filtered = useMemo(() => {
    let result = entries;

    if (search) {
      const q = search.toLowerCase();
      result = result.filter(
        (e) =>
          e.message.toLowerCase().includes(q) ||
          e.process.toLowerCase().includes(q)
      );
    }

    if (levelFilter.size > 0) {
      result = result.filter((e) => levelFilter.has(e.level));
    }

    if (processFilter) {
      const q = processFilter.toLowerCase();
      result = result.filter((e) => e.process.toLowerCase().includes(q));
    }

    return result;
  }, [entries, search, levelFilter, processFilter]);

  // Unique processes from current entries (for inline filter)
  const uniqueProcesses = useMemo(() => {
    const set = new Set(entries.map((e) => e.process));
    return Array.from(set).sort();
  }, [entries]);

  const toggleLevel = (level: string) => {
    const next = new Set(levelFilter);
    if (next.has(level)) next.delete(level);
    else next.add(level);
    setLevelFilter(next);
  };

  const levelCounts = useMemo(() => {
    const c: Record<string, number> = { error: 0, warning: 0, info: 0, debug: 0, default: 0 };
    for (const e of entries) c[e.level] = (c[e.level] || 0) + 1;
    return c;
  }, [entries]);

  return (
    <div className="space-y-4 h-[calc(100vh-5.5rem)] flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between flex-shrink-0">
        <div>
          <h1 className="text-2xl font-bold text-white">Logs</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {entries.length} entries &middot; showing {filtered.length}
            {processFilter && <span> &middot; filtered by <span className="text-purple-400">{processFilter}</span></span>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setPaused(!paused)}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium transition-all",
              paused
                ? "bg-amber-500/15 text-amber-400 ring-1 ring-amber-500/30"
                : "bg-green-500/15 text-green-400 ring-1 ring-green-500/30"
            )}
          >
            {paused ? <Play className="w-3 h-3" /> : <Pause className="w-3 h-3" />}
            {paused ? "Resume" : "Streaming"}
          </button>
          <button
            onClick={clear}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium text-gray-500 hover:text-gray-300 hover:bg-white/[0.04] transition-all"
          >
            <Trash2 className="w-3 h-3" />
            Clear
          </button>
        </div>
      </div>

      {/* Filters bar */}
      <div className="flex items-center gap-3 flex-shrink-0 flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
          <input
            type="text"
            placeholder="Search logs..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-4 py-2 rounded-xl bg-white/[0.04] border border-white/[0.06] text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/20 transition-all"
          />
        </div>

        {/* Level chips */}
        <div className="flex gap-1">
          {["error", "warning", "info", "debug"].map((level) => (
            <button
              key={level}
              onClick={() => toggleLevel(level)}
              className={cn(
                "px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all",
                levelFilter.has(level)
                  ? levelColors[level] + " ring-1 ring-current/20"
                  : "text-gray-600 hover:text-gray-400 hover:bg-white/[0.04]"
              )}
            >
              {level.charAt(0).toUpperCase() + level.slice(1)}
              <span className="ml-1 opacity-60">{levelCounts[level]}</span>
            </button>
          ))}
        </div>

        {/* Process source picker */}
        <div className="relative">
          <button
            onClick={() => setShowProcessPicker(!showProcessPicker)}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all",
              processFilter
                ? "bg-purple-500/10 text-purple-400 ring-1 ring-purple-500/30"
                : "text-gray-500 hover:text-gray-300 hover:bg-white/[0.04]"
            )}
          >
            <Filter className="w-3 h-3" />
            {processFilter || "Source"}
            <ChevronDown className="w-3 h-3" />
          </button>

          <AnimatePresence>
            {showProcessPicker && (
              <motion.div
                initial={{ opacity: 0, y: -5 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -5 }}
                className="absolute top-full left-0 mt-1 w-72 glass rounded-xl border border-white/[0.06] shadow-xl z-50 max-h-64 overflow-y-auto"
              >
                <div className="p-2">
                  <button
                    onClick={() => { setProcessFilter(""); setShowProcessPicker(false); }}
                    className={cn(
                      "w-full text-left px-3 py-1.5 rounded-lg text-xs transition-colors",
                      !processFilter ? "bg-purple-500/10 text-purple-400" : "text-gray-400 hover:bg-white/[0.04]"
                    )}
                  >
                    All Sources
                  </button>
                  {activeProcesses.length > 0 && (
                    <div className="text-[10px] text-gray-600 px-3 pt-2 pb-1 font-medium uppercase tracking-wide">Active Sources ({activeProcesses.length})</div>
                  )}
                  {activeProcesses.slice(0, 30).map((p) => (
                    <button
                      key={p.name}
                      onClick={() => { setProcessFilter(p.name); setShowProcessPicker(false); }}
                      className={cn(
                        "w-full text-left px-3 py-1.5 rounded-lg text-xs transition-colors flex items-center justify-between",
                        processFilter === p.name ? "bg-purple-500/10 text-purple-400" : "text-gray-400 hover:bg-white/[0.04]"
                      )}
                    >
                      <span className="font-mono truncate">{p.name}</span>
                      <span className="text-gray-600 ml-2 flex-shrink-0">{p.count}</span>
                    </button>
                  ))}
                  {uniqueProcesses.length > 0 && activeProcesses.length === 0 && (
                    <>
                      <div className="text-[10px] text-gray-600 px-3 pt-2 pb-1 font-medium uppercase tracking-wide">From Current Entries</div>
                      {uniqueProcesses.slice(0, 30).map((p) => (
                        <button
                          key={p}
                          onClick={() => { setProcessFilter(p); setShowProcessPicker(false); }}
                          className={cn(
                            "w-full text-left px-3 py-1.5 rounded-lg text-xs font-mono transition-colors",
                            processFilter === p ? "bg-purple-500/10 text-purple-400" : "text-gray-400 hover:bg-white/[0.04]"
                          )}
                        >
                          {p}
                        </button>
                      ))}
                    </>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Active process filter badge */}
        {processFilter && (
          <div className="flex items-center gap-1 px-2 py-1 rounded-lg bg-purple-500/10 text-purple-400 text-xs">
            <Filter className="w-3 h-3" />
            {processFilter}
            <button onClick={() => setProcessFilter("")} className="hover:text-purple-300">
              <X className="w-3 h-3" />
            </button>
          </div>
        )}
      </div>

      {/* Log stream */}
      <GlowCard className="flex-1 min-h-0 !p-0 relative overflow-hidden">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="h-full overflow-y-auto p-2 space-y-0.5 font-mono text-[11px]"
        >
          {filtered.map((entry, i) => (
            <LogLine
              key={i}
              entry={entry}
              onProcessClick={(p) => setProcessFilter(p)}
            />
          ))}
          {filtered.length === 0 && (
            <div className="flex items-center justify-center h-full text-gray-600 text-sm">
              {entries.length === 0
                ? "Waiting for log entries..."
                : "No logs match your filters"}
            </div>
          )}
        </div>

        {/* New logs indicator */}
        <AnimatePresence>
          {!autoScroll && newCount > 0 && (
            <motion.button
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 10 }}
              onClick={scrollToBottom}
              className="absolute bottom-3 right-3 flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-cyan-500/20 text-cyan-400 text-xs font-medium backdrop-blur-sm ring-1 ring-cyan-500/30 hover:bg-cyan-500/30 transition-colors"
            >
              <ArrowDown className="w-3 h-3" />
              {newCount} new
            </motion.button>
          )}
        </AnimatePresence>
      </GlowCard>
    </div>
  );
}

function LogLine({
  entry,
  onProcessClick,
}: {
  entry: LogEntry;
  onProcessClick: (process: string) => void;
}) {
  return (
    <div
      className={cn(
        "flex gap-2 py-1 px-2 rounded hover:bg-white/[0.03] transition-colors border-l-2",
        levelBorder[entry.level]
      )}
    >
      <span className="text-gray-600 flex-shrink-0 w-20 truncate">
        {entry.timestamp.split(" ").pop()?.split(".")[0] ||
          new Date(entry.timestamp).toLocaleTimeString()}
      </span>
      <span
        className={cn(
          "flex-shrink-0 w-8 text-center rounded px-1",
          levelColors[entry.level]
        )}
      >
        {entry.level.slice(0, 3).toUpperCase()}
      </span>
      <span
        className="text-purple-400/70 flex-shrink-0 w-28 truncate cursor-pointer hover:text-purple-300"
        onClick={() => onProcessClick(entry.process)}
        title={entry.process}
      >
        {entry.process}
      </span>
      {entry.pid && (
        <span className="text-gray-700 flex-shrink-0 w-12">
          [{entry.pid}]
        </span>
      )}
      <span className="text-gray-400 truncate flex-1">{entry.message}</span>
    </div>
  );
}
