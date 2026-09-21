import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useJobEventsStore, useNavStore, useServicesStore, type ServiceInfo } from "@/stores/app";
import { GlowCard } from "@/components/ui/GlowCard";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { useConfirm } from "@/components/ui/ConfirmButton";
import { toast } from "@/components/ui/Toast";
import { JobEditor, type JobEditorTarget } from "@/components/jobs/JobEditor";
import { JobDetailDrawer } from "@/components/jobs/JobDetailDrawer";
import { JobEventsDrawer, JobTimeline, StartupExtrasCard } from "@/components/jobs/JobPanels";
import { backend, metaKey, type JobMeta, type ServiceAction } from "@/lib/backend";
import { cn } from "@/lib/utils";
import { JOB_SCOPES, JOB_TEMPLATES, type JobCategory } from "@shared/launchd";
import {
  Bell,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  Copy,
  List,
  Pencil,
  Play,
  Plus,
  Power,
  PowerOff,
  RotateCw,
  Search,
  ShieldAlert,
  Square,
} from "lucide-react";

const categoryOrder: JobCategory[] = JOB_SCOPES.map((s) => s.category);
const categoryLabels = Object.fromEntries(JOB_SCOPES.map((s) => [s.category, s.title])) as Record<JobCategory, string>;

type StatusFilter = "all" | "running" | "stopped" | "error" | "disabled";
type OwnerFilter = "all" | "apple" | "third-party";
type View = "groups" | "timeline";

const ROWS_PER_GROUP = 250;
const serviceKey = (s: { category: string; label: string }) => `${s.category}/${s.label}`;

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
  const loading = useServicesStore((s) => s.loading);
  const setServices = useServicesStore((s) => s.setServices);
  const navigateToProcess = useNavStore((s) => s.navigateToProcess);
  const navigateToLogs = useNavStore((s) => s.navigateToLogs);
  const targetServiceLabel = useNavStore((s) => s.targetServiceLabel);
  const unseenEvents = useJobEventsStore((s) => s.unseen);

  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set(["system-agents", "system-daemons"]));
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [filterStatus, setFilterStatus] = useState<StatusFilter>("all");
  const [filterOwner, setFilterOwner] = useState<OwnerFilter>("all");
  const [filterTag, setFilterTag] = useState<string | null>(null);
  const [view, setView] = useState<View>("groups");
  const [editor, setEditor] = useState<JobEditorTarget | null>(null);
  const [eventsOpen, setEventsOpen] = useState(false);
  const [templateMenu, setTemplateMenu] = useState(false);
  const [meta, setMeta] = useState<Record<string, JobMeta>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const { confirm, isArmed } = useConfirm<string>();

  // The selected job follows live updates because it is looked up by key on every render.
  const selected = useMemo(() => services.find((s) => serviceKey(s) === selectedKey) ?? null, [services, selectedKey]);

  useEffect(() => {
    backend.getJobMeta().then(setMeta).catch(() => {});
  }, []);

  // Jump from another page (process detail → service). Handle each request once.
  const handledTarget = useRef<string | null>(null);
  useEffect(() => {
    if (!targetServiceLabel || handledTarget.current === targetServiceLabel) return;
    const match = services.find((s) => s.label === targetServiceLabel);
    if (match) {
      handledTarget.current = targetServiceLabel;
      setSelectedKey(serviceKey(match));
    }
  }, [targetServiceLabel, services]);

  const refresh = useCallback(async () => {
    try {
      setServices((await backend.getServices()).services);
    } catch {
      // The next poll or WebSocket snapshot brings the list.
    }
  }, [setServices]);

  const handleAction = useCallback(
    async (action: ServiceAction, service: ServiceInfo) => {
      const key = `${action}:${serviceKey(service)}`;
      setBusy(key);
      try {
        await backend.manageService({ label: service.label, category: service.category }, action);
        toast.success(`${service.label}: ${action} done`);
      } catch (e) {
        toast.error(`${service.label}: ${(e as Error).message}`);
      } finally {
        setBusy(null);
        refresh();
      }
    },
    [refresh]
  );

  const requestAction = useCallback(
    (action: ServiceAction, service: ServiceInfo) => {
      // Stopping or disabling can take a daemon away from the system: ask twice.
      const destructive = action === "stop" || action === "disable" || action === "unload";
      if (destructive) confirm(`${action}:${serviceKey(service)}`, () => handleAction(action, service));
      else handleAction(action, service);
    },
    [confirm, handleAction]
  );

  const deleteJob = async (service: ServiceInfo) => {
    try {
      await backend.deleteJob({ label: service.label, category: service.category });
      toast.success(`${service.label} moved to the Trash`);
      setSelectedKey(null);
      setMeta(({ [serviceKey(service)]: _deleted, ...rest }) => rest);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      refresh();
    }
  };

  const allTags = useMemo(() => [...new Set(Object.values(meta).flatMap((m) => m.tags))].sort(), [meta]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return services.filter((s) => {
      const m = meta[metaKey(s)];
      if (
        q &&
        !s.label.toLowerCase().includes(q) &&
        !s.program?.toLowerCase().includes(q) &&
        !s.plistPath?.toLowerCase().includes(q) &&
        !m?.notes.toLowerCase().includes(q) &&
        !m?.tags.some((t) => t.toLowerCase().includes(q))
      )
        return false;
      if (filterStatus === "disabled" ? !s.disabled : filterStatus !== "all" && s.status !== filterStatus) return false;
      if (filterOwner === "apple" && !isAppleService(s)) return false;
      if (filterOwner === "third-party" && isAppleService(s)) return false;
      if (filterTag && !m?.tags.includes(filterTag)) return false;
      return true;
    });
  }, [services, search, filterStatus, filterOwner, filterTag, meta]);

  const grouped = useMemo(() => {
    const groups: Partial<Record<JobCategory, ServiceInfo[]>> = {};
    for (const s of filtered) (groups[s.category] ??= []).push(s);
    return groups;
  }, [filtered]);

  const statusCounts = useMemo(() => {
    const c = { running: 0, stopped: 0, error: 0, unknown: 0, disabled: 0 };
    for (const s of services) {
      c[s.status]++;
      if (s.disabled) c.disabled++;
    }
    return c;
  }, [services]);

  const toggle = (set: Set<string>, update: (next: Set<string>) => void, key: string) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    update(next);
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-white">Services</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {services.length} launchd jobs &middot; {statusCounts.running} running &middot; {statusCounts.error} failed
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div role="radiogroup" aria-label="View" className="inline-flex rounded-xl bg-white/[0.04] p-0.5">
            {(
              [
                { id: "groups", icon: List, label: "Groups" },
                { id: "timeline", icon: CalendarClock, label: "Timeline" },
              ] as const
            ).map((v) => (
              <button
                key={v.id}
                type="button"
                role="radio"
                aria-checked={view === v.id}
                onClick={() => setView(v.id)}
                className={cn(
                  "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors",
                  view === v.id ? "bg-white/[0.08] text-gray-100" : "text-gray-500 hover:text-gray-300"
                )}
              >
                <v.icon className="w-3.5 h-3.5" aria-hidden />
                {v.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => setEventsOpen(true)}
            className="relative inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium text-gray-300 bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06]"
          >
            <Bell className="w-3.5 h-3.5" aria-hidden />
            Changes
            {unseenEvents > 0 && (
              <span className="ml-1 min-w-4 h-4 px-1 rounded-full bg-amber-400 text-[10px] font-bold text-amber-950 inline-flex items-center justify-center">
                {unseenEvents}
                <span className="sr-only"> new job changes</span>
              </span>
            )}
          </button>

          <div className="relative">
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={templateMenu}
              onClick={() => setTemplateMenu(!templateMenu)}
              onBlur={(e) => !e.currentTarget.parentElement?.contains(e.relatedTarget) && setTemplateMenu(false)}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold text-cyan-950 bg-cyan-400 hover:bg-cyan-300"
            >
              <Plus className="w-3.5 h-3.5" aria-hidden />
              New job
              <ChevronDown className="w-3 h-3" aria-hidden />
            </button>
            {templateMenu && (
              <div role="menu" className="absolute right-0 mt-1 w-72 z-40 glass rounded-xl border border-white/[0.08] p-1 shadow-2xl">
                {JOB_TEMPLATES.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setTemplateMenu(false);
                      setEditor({ mode: "new", templateId: t.id });
                    }}
                    onBlur={(e) => !e.currentTarget.parentElement?.parentElement?.contains(e.relatedTarget) && setTemplateMenu(false)}
                    className="w-full text-left px-3 py-2 rounded-lg hover:bg-white/[0.06]"
                  >
                    <div className="text-xs font-medium text-gray-200">{t.title}</div>
                    <div className="text-[11px] text-gray-500">{t.description}</div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-52 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" aria-hidden />
          <input
            type="search"
            aria-label="Search jobs"
            placeholder="Search label, program, notes, tags…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-4 py-2 rounded-xl bg-white/[0.04] border border-white/[0.06] text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/20 transition-all"
          />
        </div>

        <div className="flex gap-1" role="group" aria-label="Status filter">
          {(["all", "running", "stopped", "error", "disabled"] as StatusFilter[]).map((s) => (
            <FilterButton key={s} active={filterStatus === s} tone="cyan" onClick={() => setFilterStatus(s)}>
              {s.charAt(0).toUpperCase() + s.slice(1)}
              {s !== "all" && <span className="ml-1 opacity-60">{statusCounts[s]}</span>}
            </FilterButton>
          ))}
        </div>

        <div className="flex gap-1 border-l border-white/[0.06] pl-3" role="group" aria-label="Owner filter">
          {(
            [
              { value: "all", label: "All" },
              { value: "apple", label: "Apple" },
              { value: "third-party", label: "3rd Party" },
            ] as { value: OwnerFilter; label: string }[]
          ).map(({ value, label }) => (
            <FilterButton key={value} active={filterOwner === value} tone="purple" onClick={() => setFilterOwner(value)}>
              {label}
            </FilterButton>
          ))}
        </div>

        {allTags.length > 0 && (
          <div className="flex gap-1 border-l border-white/[0.06] pl-3 flex-wrap" role="group" aria-label="Tag filter">
            {allTags.map((tag) => (
              <FilterButton key={tag} active={filterTag === tag} tone="amber" onClick={() => setFilterTag(filterTag === tag ? null : tag)}>
                #{tag}
              </FilterButton>
            ))}
          </div>
        )}
      </div>

      {view === "timeline" ? (
        <JobTimeline services={filtered} onSelect={(s) => setSelectedKey(serviceKey(s))} />
      ) : (
        <div className="space-y-3">
          {loading && services.length === 0 && <p className="text-sm text-gray-500 text-center py-10">Reading launchd…</p>}
          {!loading && filtered.length === 0 && <p className="text-sm text-gray-500 text-center py-10">No job matches the filters.</p>}

          {categoryOrder.map((category) => {
            const items = grouped[category];
            if (!items || items.length === 0) return null;
            const isCollapsed = collapsed.has(category);
            const showAll = expandedGroups.has(category);
            const visible = showAll ? items : items.slice(0, ROWS_PER_GROUP);

            return (
              <GlowCard key={category} padding="sm">
                <button
                  type="button"
                  aria-expanded={!isCollapsed}
                  onClick={() => toggle(collapsed, setCollapsed, category)}
                  className="w-full flex items-center gap-2 px-2 py-1.5 hover:bg-white/[0.03] rounded-lg transition-colors"
                >
                  {isCollapsed ? <ChevronRight className="w-4 h-4 text-gray-500" aria-hidden /> : <ChevronDown className="w-4 h-4 text-gray-400" aria-hidden />}
                  <span className="text-sm font-semibold text-gray-300">{categoryLabels[category]}</span>
                  <span className="text-xs text-gray-600 ml-1">({items.length})</span>
                  <span className="ml-auto text-xs text-green-400/70">{items.filter((s) => s.status === "running").length} running</span>
                </button>

                {!isCollapsed && (
                  <div className="mt-1 space-y-0.5">
                    {visible.map((service) => {
                      const key = serviceKey(service);
                      return (
                        <ServiceRow
                          key={key}
                          service={service}
                          tags={meta[key]?.tags}
                          busy={busy !== null && busy.endsWith(`:${key}`)}
                          armedAction={(["stop", "disable"] as const).find((a) => isArmed(`${a}:${key}`)) ?? null}
                          onAction={requestAction}
                          onSelect={setSelectedKey}
                          onEdit={setEditor}
                        />
                      );
                    })}
                    {items.length > visible.length && (
                      <button
                        type="button"
                        onClick={() => toggle(expandedGroups, setExpandedGroups, category)}
                        className="w-full py-2 text-xs text-cyan-400 hover:bg-white/[0.03] rounded-lg"
                      >
                        Show {items.length - visible.length} more
                      </button>
                    )}
                  </div>
                )}
              </GlowCard>
            );
          })}

          <StartupExtrasCard />
        </div>
      )}

      <JobDetailDrawer
        service={selected}
        meta={selected ? meta[serviceKey(selected)] : undefined}
        onClose={() => setSelectedKey(null)}
        onEdit={() => selected && setEditor({ mode: "edit", job: { label: selected.label, category: selected.category } })}
        onDuplicate={() => selected && setEditor({ mode: "duplicate", job: { label: selected.label, category: selected.category } })}
        onDelete={() => selected && deleteJob(selected)}
        onMetaSaved={(m) => selected && setMeta((all) => ({ ...all, [serviceKey(selected)]: m }))}
        onNavigateToProcess={(pid) => {
          setSelectedKey(null);
          navigateToProcess(pid);
        }}
        onViewLogs={(name) => navigateToLogs(name)}
      />

      <JobEventsDrawer
        open={eventsOpen}
        onClose={() => setEventsOpen(false)}
        onOpenJob={(event) => {
          setEventsOpen(false);
          setSelectedKey(serviceKey(event));
        }}
      />

      <JobEditor
        target={editor}
        onClose={() => {
          setEditor(null);
          refresh();
        }}
      />
    </div>
  );
}

function FilterButton({
  active,
  tone,
  onClick,
  children,
}: {
  active: boolean;
  tone: "cyan" | "purple" | "amber";
  onClick: () => void;
  children: React.ReactNode;
}) {
  const tones = {
    cyan: "bg-cyan-500/15 text-cyan-400 ring-1 ring-cyan-500/30",
    purple: "bg-purple-500/15 text-purple-400 ring-1 ring-purple-500/30",
    amber: "bg-amber-500/15 text-amber-400 ring-1 ring-amber-500/30",
  };
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "px-3 py-1.5 rounded-lg text-xs font-medium transition-all",
        active ? tones[tone] : "text-gray-500 hover:text-gray-300 hover:bg-white/[0.04]"
      )}
    >
      {children}
    </button>
  );
}

const iconButton = "p-1.5 rounded-lg text-gray-500 transition-colors disabled:opacity-40 focus-visible:ring-1 focus-visible:ring-cyan-500/50 focus:outline-none";

const ServiceRow = memo(function ServiceRow({
  service,
  tags,
  busy,
  armedAction,
  onAction,
  onSelect,
  onEdit,
}: {
  service: ServiceInfo;
  tags: string[] | undefined;
  busy: boolean;
  armedAction: "stop" | "disable" | null;
  onAction: (action: ServiceAction, service: ServiceInfo) => void;
  onSelect: (key: string) => void;
  onEdit: (target: JobEditorTarget) => void;
}) {
  const ref = { label: service.label, category: service.category };
  const hasFile = service.plistPath !== null;
  const act = (action: ServiceAction) => (e: React.MouseEvent) => {
    e.stopPropagation();
    onAction(action, service);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`${service.label}, ${service.disabled ? "disabled" : service.status}. Open details`}
      onClick={() => onSelect(serviceKey(service))}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onSelect(serviceKey(service));
        }
      }}
      className={cn(
        "flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-white/[0.03] transition-colors group text-xs cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-cyan-500/50",
        service.disabled && "opacity-50"
      )}
    >
      <StatusBadge status={service.status} label="" size="sm" />

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-gray-200 font-medium truncate font-mono text-[12px]">{service.label}</span>
          {service.disabled && <Badge tone="amber">disabled</Badge>}
          {(service.unreadable || service.quarantined) && (
            <span title={service.unreadable ? "The plist cannot be parsed" : "The plist is quarantined"} className="text-red-400 flex-shrink-0">
              <ShieldAlert className="w-3.5 h-3.5" aria-hidden />
              <span className="sr-only">{service.unreadable ? "unreadable plist" : "quarantined plist"}</span>
            </span>
          )}
          {tags?.map((t) => (
            <Badge key={t} tone="gray">
              #{t}
            </Badge>
          ))}
        </div>
        <div className="flex items-center gap-2 text-[10px] text-gray-600 min-w-0">
          {service.program && (
            <span className="truncate" title={service.program}>
              {service.program}
            </span>
          )}
          {service.triggers.length > 0 && <span className="flex-shrink-0 text-cyan-500/60">{service.triggers.join(" · ")}</span>}
        </div>
      </div>

      {service.pid !== null && <span className="text-gray-600 font-mono text-[10px] flex-shrink-0">PID {service.pid}</span>}

      <div className={cn("flex gap-1 transition-opacity", armedAction ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100")}>
        {service.status === "running" ? (
          <>
            <button type="button" disabled={busy} onClick={act("stop")} aria-label={armedAction === "stop" ? `Confirm stop ${service.label}` : `Stop ${service.label}`} title={armedAction === "stop" ? "Click again to stop" : "Stop"} className={cn(iconButton, armedAction === "stop" ? "bg-red-500/25 text-red-300" : "hover:bg-red-500/10 hover:text-red-400")}>
              <Square className="w-3 h-3" aria-hidden />
            </button>
            <button type="button" disabled={busy} onClick={act("restart")} aria-label={`Restart ${service.label}`} title="Restart" className={cn(iconButton, "hover:bg-cyan-500/10 hover:text-cyan-400")}>
              <RotateCw className="w-3 h-3" aria-hidden />
            </button>
          </>
        ) : (
          <button type="button" disabled={busy} onClick={act("start")} aria-label={`Run ${service.label} now`} title="Run now" className={cn(iconButton, "hover:bg-green-500/10 hover:text-green-400")}>
            <Play className="w-3 h-3" aria-hidden />
          </button>
        )}

        {service.disabled ? (
          <button type="button" disabled={busy} onClick={act("enable")} aria-label={`Enable ${service.label}`} title="Enable and load" className={cn(iconButton, "hover:bg-cyan-500/10 hover:text-cyan-400")}>
            <Power className="w-3 h-3" aria-hidden />
          </button>
        ) : (
          <button type="button" disabled={busy} onClick={act("disable")} aria-label={armedAction === "disable" ? `Confirm disable ${service.label}` : `Disable ${service.label}`} title={armedAction === "disable" ? "Click again to disable" : "Disable and unload"} className={cn(iconButton, armedAction === "disable" ? "bg-amber-500/25 text-amber-300" : "hover:bg-amber-500/10 hover:text-amber-400")}>
            <PowerOff className="w-3 h-3" aria-hidden />
          </button>
        )}

        {hasFile && (
          <>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onEdit({ mode: "edit", job: ref });
              }}
              aria-label={`${service.writable ? "Edit" : "View"} ${service.label}`}
              title={service.writable ? "Edit" : "View plist"}
              className={cn(iconButton, "hover:bg-white/[0.06] hover:text-gray-300")}
            >
              <Pencil className="w-3 h-3" aria-hidden />
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onEdit({ mode: "duplicate", job: ref });
              }}
              aria-label={`Duplicate ${service.label}`}
              title="Duplicate"
              className={cn(iconButton, "hover:bg-white/[0.06] hover:text-gray-300")}
            >
              <Copy className="w-3 h-3" aria-hidden />
            </button>
          </>
        )}
      </div>
    </div>
  );
});

function Badge({ tone, children }: { tone: "amber" | "gray"; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "flex-shrink-0 px-1.5 py-px rounded text-[9px] font-medium",
        tone === "amber" ? "bg-amber-500/15 text-amber-400" : "bg-white/[0.06] text-gray-400"
      )}
    >
      {children}
    </span>
  );
}
