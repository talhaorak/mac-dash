import { useState, useMemo, useEffect } from "react";
import { useServicesStore, useNavStore, type ServiceInfo } from "@/stores/app";
import { GlowCard } from "@/components/ui/GlowCard";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { CopyButton } from "@/components/ui/CopyButton";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  Search,
  ChevronDown,
  ChevronRight,
  Play,
  Square,
  Power,
  PowerOff,
  X,
  FileText,
  FolderOpen,
  Terminal,
  Eye,
  ExternalLink,
  Activity,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

const categoryLabels: Record<string, string> = {
  "user-agents": "User Agents",
  "global-agents": "Global Agents",
  "global-daemons": "Global Daemons",
  "system-agents": "System Agents",
  "system-daemons": "System Daemons",
};

const categoryOrder = [
  "user-agents",
  "global-agents",
  "global-daemons",
  "system-agents",
  "system-daemons",
];

type OwnerFilter = "all" | "apple" | "third-party";

function isAppleService(s: ServiceInfo): boolean {
  return (
    s.label.startsWith("com.apple.") ||
    s.plistPath?.includes("/System/") === true ||
    s.program?.startsWith("/System/") === true ||
    s.program?.startsWith("/usr/libexec/") === true
  );
}

export function ServicesPage() {
  const services = useServicesStore((s) => s.services);
  const navigateToProcess = useNavStore((s) => s.navigateToProcess);
  const targetServiceLabel = useNavStore((s) => s.targetServiceLabel);
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(
    new Set(["system-agents", "system-daemons"])
  );
  const [selectedService, setSelectedService] = useState<ServiceInfo | null>(
    null
  );
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [filterOwner, setFilterOwner] = useState<OwnerFilter>("all");

  // Handle navigation from other pages (e.g. process detail -> service)
  useEffect(() => {
    if (targetServiceLabel && services.length > 0) {
      const service = services.find((s) => s.label === targetServiceLabel);
      if (service) {
        setSelectedService(service);
      }
    }
  }, [targetServiceLabel, services]);

  const filtered = useMemo(() => {
    let result = services;
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(
        (s) =>
          s.label.toLowerCase().includes(q) ||
          s.program?.toLowerCase().includes(q) ||
          s.plistPath?.toLowerCase().includes(q)
      );
    }
    if (filterStatus !== "all") {
      result = result.filter((s) => s.status === filterStatus);
    }
    if (filterOwner === "apple") {
      result = result.filter(isAppleService);
    } else if (filterOwner === "third-party") {
      result = result.filter((s) => !isAppleService(s));
    }
    return result;
  }, [services, search, filterStatus, filterOwner]);

  const grouped = useMemo(() => {
    const groups: Record<string, ServiceInfo[]> = {};
    for (const s of filtered) {
      if (!groups[s.category]) groups[s.category] = [];
      groups[s.category].push(s);
    }
    return groups;
  }, [filtered]);

  const toggleCollapse = (category: string) => {
    const next = new Set(collapsed);
    if (next.has(category)) next.delete(category);
    else next.add(category);
    setCollapsed(next);
  };

  const handleAction = async (
    action: "start" | "stop" | "enable" | "disable",
    service: ServiceInfo
  ) => {
    try {
      if (action === "start") {
        await api.post(`/services/${service.label}/start`);
      } else if (action === "stop") {
        await api.post(`/services/${service.label}/stop`);
      } else if (action === "enable") {
        await api.post(`/services/${service.label}/enable`, {
          plistPath: service.plistPath,
        });
      } else if (action === "disable") {
        await api.post(`/services/${service.label}/disable`, {
          plistPath: service.plistPath,
        });
      }
    } catch (e: any) {
      console.error(`Action ${action} failed:`, e.message);
    }
  };

  const statusCounts = useMemo(() => {
    const c = { running: 0, stopped: 0, error: 0, unknown: 0 };
    for (const s of services) c[s.status]++;
    return c;
  }, [services]);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Services</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {services.length} services &middot; {statusCounts.running} running
          </p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
          <input
            type="text"
            placeholder="Search services..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-4 py-2 rounded-xl bg-white/[0.04] border border-white/[0.06] text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/20 transition-all"
          />
        </div>

        {/* Status filter */}
        <div className="flex gap-1">
          {["all", "running", "stopped", "error"].map((s) => (
            <button
              key={s}
              onClick={() => setFilterStatus(s)}
              className={cn(
                "px-3 py-1.5 rounded-lg text-xs font-medium transition-all",
                filterStatus === s
                  ? "bg-cyan-500/15 text-cyan-400 ring-1 ring-cyan-500/30"
                  : "text-gray-500 hover:text-gray-300 hover:bg-white/[0.04]"
              )}
            >
              {s === "all" ? "All" : s.charAt(0).toUpperCase() + s.slice(1)}
              {s !== "all" && (
                <span className="ml-1 opacity-60">
                  {statusCounts[s as keyof typeof statusCounts]}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Owner filter */}
        <div className="flex gap-1 border-l border-white/[0.06] pl-3">
          {(
            [
              { value: "all" as OwnerFilter, label: "All" },
              { value: "apple" as OwnerFilter, label: "Apple" },
              { value: "third-party" as OwnerFilter, label: "3rd Party" },
            ] as const
          ).map(({ value, label }) => (
            <button
              key={value}
              onClick={() => setFilterOwner(value)}
              className={cn(
                "px-3 py-1.5 rounded-lg text-xs font-medium transition-all",
                filterOwner === value
                  ? "bg-purple-500/15 text-purple-400 ring-1 ring-purple-500/30"
                  : "text-gray-500 hover:text-gray-300 hover:bg-white/[0.04]"
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Service groups */}
      <div className="space-y-3">
        {categoryOrder.map((category) => {
          const items = grouped[category];
          if (!items || items.length === 0) return null;
          const isCollapsed = collapsed.has(category);

          return (
            <GlowCard key={category} padding="sm">
              {/* Category header */}
              <button
                onClick={() => toggleCollapse(category)}
                className="w-full flex items-center gap-2 px-2 py-1.5 hover:bg-white/[0.03] rounded-lg transition-colors"
              >
                {isCollapsed ? (
                  <ChevronRight className="w-4 h-4 text-gray-500" />
                ) : (
                  <ChevronDown className="w-4 h-4 text-gray-400" />
                )}
                <span className="text-sm font-semibold text-gray-300">
                  {categoryLabels[category] || category}
                </span>
                <span className="text-xs text-gray-600 ml-1">
                  ({items.length})
                </span>
                <div className="ml-auto flex gap-2 text-xs">
                  <span className="text-green-400/70">
                    {items.filter((s) => s.status === "running").length} running
                  </span>
                </div>
              </button>

              {/* Service rows */}
              <AnimatePresence>
                {!isCollapsed && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="overflow-hidden"
                  >
                    <div className="mt-1 space-y-0.5">
                      {items.map((service) => (
                        <ServiceRow
                          key={service.label}
                          service={service}
                          onAction={handleAction}
                          onSelect={() => setSelectedService(service)}
                          onNavigateToProcess={
                            service.pid
                              ? () => navigateToProcess(service.pid!)
                              : undefined
                          }
                        />
                      ))}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </GlowCard>
          );
        })}
      </div>

      {/* Detail Drawer */}
      <AnimatePresence>
        {selectedService && (
          <ServiceDetailDrawer
            service={selectedService}
            onClose={() => setSelectedService(null)}
            onNavigateToProcess={
              selectedService.pid
                ? () => {
                    setSelectedService(null);
                    navigateToProcess(selectedService.pid!);
                  }
                : undefined
            }
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function ServiceRow({
  service,
  onAction,
  onSelect,
  onNavigateToProcess,
}: {
  service: ServiceInfo;
  onAction: (
    action: "start" | "stop" | "enable" | "disable",
    service: ServiceInfo
  ) => void;
  onSelect: () => void;
  onNavigateToProcess?: () => void;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-white/[0.03] transition-colors group text-xs",
        onNavigateToProcess && "cursor-pointer"
      )}
      onClick={onNavigateToProcess || onSelect}
    >
      <StatusBadge status={service.status} label="" size="sm" />

      <div className="flex-1 min-w-0">
        <div className="text-gray-200 font-medium truncate font-mono text-[12px]">
          {service.label}
        </div>
        {service.program && (
          <div
            className="text-gray-600 truncate text-[10px]"
            title={service.program}
          >
            {service.program}
          </div>
        )}
      </div>

      {/* PID */}
      {service.pid && (
        <span
          className={cn(
            "text-gray-600 font-mono text-[10px]",
            onNavigateToProcess &&
              "hover:text-cyan-400 cursor-pointer transition-colors"
          )}
          onClick={(e) => {
            if (onNavigateToProcess) {
              e.stopPropagation();
              onNavigateToProcess();
            }
          }}
        >
          PID {service.pid}
          {onNavigateToProcess && (
            <Activity className="w-2.5 h-2.5 inline ml-1 opacity-0 group-hover:opacity-100" />
          )}
        </span>
      )}

      {/* Actions */}
      <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        {service.status === "running" ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onAction("stop", service);
            }}
            className="p-1.5 rounded-lg hover:bg-red-500/10 text-gray-500 hover:text-red-400 transition-colors"
            title="Stop"
          >
            <Square className="w-3 h-3" />
          </button>
        ) : (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onAction("start", service);
            }}
            className="p-1.5 rounded-lg hover:bg-green-500/10 text-gray-500 hover:text-green-400 transition-colors"
            title="Start"
          >
            <Play className="w-3 h-3" />
          </button>
        )}

        {service.enabled ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onAction("disable", service);
            }}
            className="p-1.5 rounded-lg hover:bg-amber-500/10 text-gray-500 hover:text-amber-400 transition-colors"
            title="Disable"
          >
            <PowerOff className="w-3 h-3" />
          </button>
        ) : (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onAction("enable", service);
            }}
            className="p-1.5 rounded-lg hover:bg-cyan-500/10 text-gray-500 hover:text-cyan-400 transition-colors"
            title="Enable"
          >
            <Power className="w-3 h-3" />
          </button>
        )}

        <button
          onClick={(e) => {
            e.stopPropagation();
            onSelect();
          }}
          className="p-1.5 rounded-lg hover:bg-white/[0.06] text-gray-500 hover:text-gray-300 transition-colors"
          title="Details"
        >
          <Eye className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}

function ServiceDetailDrawer({
  service,
  onClose,
  onNavigateToProcess,
}: {
  service: ServiceInfo;
  onClose: () => void;
  onNavigateToProcess?: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex justify-end"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      <motion.div
        initial={{ x: 400 }}
        animate={{ x: 0 }}
        exit={{ x: 400 }}
        transition={{ type: "spring", damping: 30, stiffness: 300 }}
        className="relative w-full max-w-md glass border-l border-white/[0.06] h-full overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6 space-y-6">
          {/* Header */}
          <div className="flex items-start justify-between">
            <div className="space-y-1">
              <h2 className="text-lg font-bold text-white">{service.label}</h2>
              <StatusBadge status={service.status} />
            </div>
            <button
              onClick={onClose}
              className="p-2 rounded-lg hover:bg-white/[0.06] text-gray-400"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Navigate to process */}
          {service.pid && onNavigateToProcess && (
            <button
              onClick={onNavigateToProcess}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl bg-cyan-500/5 border border-cyan-500/20 hover:bg-cyan-500/10 transition-colors group"
            >
              <Activity className="w-4 h-4 text-cyan-400 flex-shrink-0" />
              <div className="flex-1 text-left">
                <div className="text-xs font-medium text-cyan-300">
                  View running process
                </div>
                <div className="text-[11px] font-mono text-cyan-400/70">
                  PID {service.pid}
                </div>
              </div>
              <ExternalLink className="w-3.5 h-3.5 text-cyan-400/50 group-hover:text-cyan-400 transition-colors" />
            </button>
          )}

          {/* Properties */}
          <div className="space-y-4">
            <DetailSection
              icon={Terminal}
              label="Program"
              value={service.program || "N/A"}
              mono
            />
            <DetailSection
              icon={FolderOpen}
              label="Plist Path"
              value={service.plistPath || "N/A"}
              mono
            />
            <DetailSection
              icon={FileText}
              label="Category"
              value={
                categoryLabels[service.category] || service.category
              }
            />

            {service.pid && (
              <DetailSection
                icon={Terminal}
                label="PID"
                value={String(service.pid)}
                mono
              />
            )}

            {service.programArguments &&
              service.programArguments.length > 0 && (
                <div className="space-y-1.5 group">
                  <div className="text-xs text-gray-500 font-medium flex items-center gap-1.5">
                    <Terminal className="w-3.5 h-3.5" />
                    Arguments
                  </div>
                  <div className="relative bg-black/30 rounded-lg p-3 space-y-1">
                    {service.programArguments.map((arg, i) => (
                      <div key={i} className="text-xs font-mono text-gray-300">
                        {arg}
                      </div>
                    ))}
                    <div className="absolute top-1.5 right-1.5">
                      <CopyButton
                        text={service.programArguments.join(" ")}
                      />
                    </div>
                  </div>
                </div>
              )}

            <div className="grid grid-cols-2 gap-3">
              <div className="glass rounded-xl p-3 text-center">
                <div className="text-xs text-gray-500">Run at Load</div>
                <div className="text-sm font-semibold text-gray-200 mt-1">
                  {service.runAtLoad === null
                    ? "N/A"
                    : service.runAtLoad
                    ? "Yes"
                    : "No"}
                </div>
              </div>
              <div className="glass rounded-xl p-3 text-center">
                <div className="text-xs text-gray-500">Enabled</div>
                <div className="text-sm font-semibold text-gray-200 mt-1">
                  {service.enabled ? "Yes" : "No"}
                </div>
              </div>
            </div>

            {service.lastExitStatus !== null && (
              <div className="glass rounded-xl p-3 text-center">
                <div className="text-xs text-gray-500">Last Exit Status</div>
                <div
                  className={cn(
                    "text-sm font-mono font-semibold mt-1",
                    service.lastExitStatus === 0
                      ? "text-green-400"
                      : "text-red-400"
                  )}
                >
                  {service.lastExitStatus}
                </div>
              </div>
            )}
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

function DetailSection({
  icon: Icon,
  label,
  value,
  mono,
}: {
  icon: any;
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="space-y-1 group">
      <div className="text-xs text-gray-500 font-medium flex items-center gap-1.5">
        <Icon className="w-3.5 h-3.5" />
        {label}
      </div>
      <div
        className={cn(
          "relative text-sm text-gray-300 break-all",
          mono && "font-mono text-xs bg-black/20 rounded-lg px-3 py-2"
        )}
      >
        {value}
        {value !== "N/A" && mono && (
          <span className="absolute top-1 right-1">
            <CopyButton text={value} />
          </span>
        )}
      </div>
    </div>
  );
}
