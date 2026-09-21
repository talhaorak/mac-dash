import { memo, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Check, Columns3, ShieldAlert } from "lucide-react";
import { GlowCard } from "@/components/ui/GlowCard";
import { StatusBadge } from "@/components/ui/StatusBadge";
import type { JobEditorTarget } from "@/components/jobs/JobEditor";
import { metaKey, type JobMeta, type ServiceAction } from "@/lib/backend";
import type { ServiceInfo } from "@/stores/app";
import { cn } from "@/lib/utils";
import { JOB_SCOPES, explainExitStatus, scopeFor } from "@shared/launchd";
import { JobRowActions, serviceKey, type ArmedAction } from "./ListJobRowActions";

// ── Columns ──────────────────────────────────────────────────────────

export type JobListColumn = "name" | "scope" | "status" | "enabled" | "triggers" | "pid" | "lastExit";
type SortDirection = "asc" | "desc";

interface ColumnSpec {
  id: JobListColumn;
  title: string;
  /** Tailwind width of the column. The name column takes the rest. */
  width: string;
  /** Sort value. `null` sorts last in both directions. */
  value: (s: ServiceInfo) => string | number | null;
}

const SCOPE_RANK = new Map<string, number>(JOB_SCOPES.map((s, i) => [s.category, i]));
const STATUS_RANK: Record<ServiceInfo["status"], number> = { running: 0, error: 1, stopped: 2, unknown: 3 };

const COLUMNS: ColumnSpec[] = [
  { id: "name", title: "Name", width: "", value: (s) => s.label },
  { id: "scope", title: "Scope", width: "w-32", value: (s) => SCOPE_RANK.get(s.category) ?? 99 },
  { id: "status", title: "Status", width: "w-24", value: (s) => STATUS_RANK[s.status] },
  { id: "enabled", title: "Enabled", width: "w-24", value: (s) => (s.disabled ? 1 : 0) },
  { id: "triggers", title: "Triggers", width: "w-56", value: (s) => (s.triggers.length > 0 ? s.triggers.join(" · ") : null) },
  { id: "pid", title: "PID", width: "w-20", value: (s) => s.pid },
  { id: "lastExit", title: "Last exit", width: "w-24", value: (s) => s.lastExitStatus },
];

const COLUMN_IDS = new Set<string>(COLUMNS.map((c) => c.id));

// ── Persisted view state ─────────────────────────────────────────────

const STORAGE_KEY = "macdash.jobList";

interface ListPrefs {
  sort: { column: JobListColumn; direction: SortDirection };
  /** The name column cannot be hidden. */
  hidden: JobListColumn[];
}

const DEFAULT_PREFS: ListPrefs = { sort: { column: "name", direction: "asc" }, hidden: [] };

function loadPrefs(): ListPrefs {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "");
    const column = COLUMN_IDS.has(parsed?.sort?.column) ? (parsed.sort.column as JobListColumn) : DEFAULT_PREFS.sort.column;
    const direction: SortDirection = parsed?.sort?.direction === "desc" ? "desc" : "asc";
    const hidden = Array.isArray(parsed?.hidden)
      ? (parsed.hidden as unknown[]).filter((c): c is JobListColumn => typeof c === "string" && COLUMN_IDS.has(c) && c !== "name")
      : [];
    return { sort: { column, direction }, hidden };
  } catch {
    return DEFAULT_PREFS;
  }
}

function savePrefs(prefs: ListPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Private mode or a full quota: the view state stays for this session only.
  }
}

// ── View ─────────────────────────────────────────────────────────────

/** Rows rendered per step. The list holds about 1000 jobs. */
const WINDOW = 300;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export interface JobListViewProps {
  /** Jobs after search, filters and smart folder. */
  services: ServiceInfo[];
  /** Notes and tags by `metaKey`. */
  meta: Record<string, JobMeta>;
  /** True while the first job list is still on its way. */
  loading: boolean;
  /** `<action>:<serviceKey>` of the action in flight, or null. */
  busyKey: string | null;
  /** Tells whether `<action>:<serviceKey>` waits for its confirming click. */
  isArmed: (key: string) => boolean;
  onAction: (action: ServiceAction, service: ServiceInfo) => void;
  /** Opens the detail drawer. Receives the `serviceKey` of the job. */
  onSelect: (key: string) => void;
  onEdit: (target: JobEditorTarget) => void;
}

/** Flat table of jobs with sortable columns and a column chooser. */
export function JobListView({ services, meta, loading, busyKey, isArmed, onAction, onSelect, onEdit }: JobListViewProps) {
  const [prefs, setPrefs] = useState(loadPrefs);
  const [limit, setLimit] = useState(WINDOW);

  const updatePrefs = (next: ListPrefs) => {
    setPrefs(next);
    savePrefs(next);
  };

  const { column: sortColumn, direction } = prefs.sort;

  const sorted = useMemo(() => {
    const spec = COLUMNS.find((c) => c.id === sortColumn) ?? COLUMNS[0];
    const sign = direction === "asc" ? 1 : -1;
    return [...services].sort((a, b) => {
      const va = spec.value(a);
      const vb = spec.value(b);
      let order = 0;
      if (va === null || vb === null) {
        if (va !== vb) return va === null ? 1 : -1;
      } else if (typeof va === "number" && typeof vb === "number") {
        order = (va - vb) * sign;
      } else {
        order = collator.compare(String(va), String(vb)) * sign;
      }
      return order !== 0 ? order : collator.compare(a.label, b.label) || collator.compare(a.category, b.category);
    });
  }, [services, sortColumn, direction]);

  const visibleColumns = COLUMNS.filter((c) => !prefs.hidden.includes(c.id));
  const rows = sorted.slice(0, limit);

  const sortBy = (column: JobListColumn) => {
    setLimit(WINDOW);
    updatePrefs({ ...prefs, sort: { column, direction: sortColumn === column && direction === "asc" ? "desc" : "asc" } });
  };

  const toggleColumn = (column: JobListColumn) => {
    const hidden = prefs.hidden.includes(column) ? prefs.hidden.filter((c) => c !== column) : [...prefs.hidden, column];
    // A hidden column cannot stay the sort column: the user would not see why the order is what it is.
    const sort = hidden.includes(sortColumn) ? DEFAULT_PREFS.sort : prefs.sort;
    updatePrefs({ sort, hidden });
  };

  if (loading && services.length === 0) return <p className="text-sm text-gray-500 text-center py-10">Reading launchd…</p>;
  if (services.length === 0) return <p className="text-sm text-gray-500 text-center py-10">No job matches the filters.</p>;

  return (
    <GlowCard padding="sm">
      <div className="flex items-center gap-2 px-2 pb-2">
        <p className="text-xs text-gray-500 flex-1" aria-live="polite">
          {rows.length < sorted.length ? `${rows.length} of ${sorted.length} jobs` : `${sorted.length} jobs`}
        </p>
        <ColumnMenu hidden={prefs.hidden} onToggle={toggleColumn} />
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] table-fixed border-collapse text-xs">
          <caption className="sr-only">launchd jobs. The column header buttons sort the table.</caption>
          <thead>
            <tr className="border-b border-white/[0.06]">
              {visibleColumns.map((c) => {
                const active = sortColumn === c.id;
                const SortIcon = !active ? ArrowUpDown : direction === "asc" ? ArrowUp : ArrowDown;
                return (
                  <th
                    key={c.id}
                    scope="col"
                    aria-sort={active ? (direction === "asc" ? "ascending" : "descending") : "none"}
                    className={cn("p-0 text-left font-medium", c.width)}
                  >
                    <button
                      type="button"
                      onClick={() => sortBy(c.id)}
                      title={`Sort by ${c.title.toLowerCase()}`}
                      className={cn(
                        "w-full inline-flex items-center gap-1 px-2 py-2 rounded-lg text-[11px] uppercase tracking-wide transition-colors",
                        "hover:bg-white/[0.04] focus:outline-none focus-visible:ring-1 focus-visible:ring-cyan-500/50",
                        active ? "text-cyan-400" : "text-gray-500 hover:text-gray-300"
                      )}
                    >
                      <span className="truncate">{c.title}</span>
                      <SortIcon className={cn("w-3 h-3 flex-shrink-0", !active && "opacity-40")} aria-hidden />
                    </button>
                  </th>
                );
              })}
              <th scope="col" className="w-40 px-2 py-2 text-right text-[11px] uppercase tracking-wide font-medium text-gray-500">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((service) => {
              const key = serviceKey(service);
              return (
                <JobListRow
                  key={key}
                  service={service}
                  tags={meta[metaKey(service)]?.tags}
                  columns={visibleColumns}
                  busy={busyKey !== null && busyKey.endsWith(`:${key}`)}
                  armedAction={(["stop", "disable"] as const).find((a) => isArmed(`${a}:${key}`)) ?? null}
                  onAction={onAction}
                  onSelect={onSelect}
                  onEdit={onEdit}
                />
              );
            })}
          </tbody>
        </table>
      </div>

      {sorted.length > rows.length && (
        <button
          type="button"
          onClick={() => setLimit((n) => n + WINDOW)}
          className="w-full mt-1 py-2 text-xs text-cyan-400 hover:bg-white/[0.03] rounded-lg focus:outline-none focus-visible:ring-1 focus-visible:ring-cyan-500/50"
        >
          Show {Math.min(WINDOW, sorted.length - rows.length)} more ({sorted.length - rows.length} hidden)
        </button>
      )}
    </GlowCard>
  );
}

// ── Row ──────────────────────────────────────────────────────────────

const JobListRow = memo(function JobListRow({
  service,
  tags,
  columns,
  busy,
  armedAction,
  onAction,
  onSelect,
  onEdit,
}: {
  service: ServiceInfo;
  tags: string[] | undefined;
  columns: ColumnSpec[];
  busy: boolean;
  armedAction: ArmedAction | null;
  onAction: (action: ServiceAction, service: ServiceInfo) => void;
  onSelect: (key: string) => void;
  onEdit: (target: JobEditorTarget) => void;
}) {
  const open = () => onSelect(serviceKey(service));

  const cell = (column: JobListColumn) => {
    switch (column) {
      case "name":
        return (
          <div className="min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              {/* The button gives keyboard and screen-reader users the row action. The mouse can click the whole row. */}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  open();
                }}
                aria-label={`${service.label}. Open details`}
                className="min-w-0 truncate text-left font-mono text-[12px] font-medium text-gray-200 rounded hover:text-cyan-300 focus:outline-none focus-visible:ring-1 focus-visible:ring-cyan-500/50"
              >
                {service.label}
              </button>
              {(service.unreadable || service.quarantined) && (
                <span title={service.unreadable ? "The plist cannot be parsed" : "The plist is quarantined"} className="text-red-400 flex-shrink-0">
                  <ShieldAlert className="w-3.5 h-3.5" aria-hidden />
                  <span className="sr-only">{service.unreadable ? "unreadable plist" : "quarantined plist"}</span>
                </span>
              )}
              {tags?.map((t) => (
                <span key={t} className="flex-shrink-0 px-1.5 py-px rounded text-[9px] font-medium bg-white/[0.06] text-gray-400">
                  #{t}
                </span>
              ))}
            </div>
            {service.program && (
              <div className="truncate text-[10px] text-gray-600" title={service.program}>
                {service.program}
              </div>
            )}
          </div>
        );
      case "scope":
        return <span className="text-gray-400">{scopeFor(service.category)?.title ?? service.category}</span>;
      case "status":
        return <StatusBadge status={service.status} size="sm" />;
      case "enabled":
        return service.disabled ? (
          <span className="px-1.5 py-px rounded text-[10px] font-medium bg-amber-500/15 text-amber-400">Disabled</span>
        ) : (
          <span className="text-gray-400">Enabled</span>
        );
      case "triggers":
        return service.triggers.length > 0 ? (
          <span className="block truncate text-cyan-500/70" title={service.triggers.join(" · ")}>
            {service.triggers.join(" · ")}
          </span>
        ) : (
          <Empty />
        );
      case "pid":
        return service.pid !== null ? <span className="font-mono text-gray-400">{service.pid}</span> : <Empty />;
      case "lastExit":
        return service.lastExitStatus !== null ? (
          <span
            title={explainExitStatus(service.lastExitStatus) ?? undefined}
            className={cn("font-mono", service.lastExitStatus === 0 ? "text-gray-400" : "text-red-400")}
          >
            {service.lastExitStatus}
            {service.lastExitStatus !== 0 && <span className="sr-only"> (failed)</span>}
          </span>
        ) : (
          <Empty />
        );
    }
  };

  return (
    <tr
      onClick={open}
      className={cn("group cursor-pointer border-b border-white/[0.03] hover:bg-white/[0.03] transition-colors", service.disabled && "opacity-50")}
    >
      {columns.map((c) => (
        <td key={c.id} className="px-2 py-1.5 align-middle overflow-hidden">
          {cell(c.id)}
        </td>
      ))}
      <td className="px-2 py-1.5 align-middle">
        <JobRowActions
          service={service}
          busy={busy}
          armedAction={armedAction}
          onAction={onAction}
          onEdit={onEdit}
          className={cn("justify-end transition-opacity", armedAction ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100")}
        />
      </td>
    </tr>
  );
});

function Empty() {
  return (
    <span className="text-gray-700">
      <span aria-hidden>–</span>
      <span className="sr-only">none</span>
    </span>
  );
}

// ── Column chooser ───────────────────────────────────────────────────

function ColumnMenu({ hidden, onToggle }: { hidden: JobListColumn[]; onToggle: (column: JobListColumn) => void }) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Safari does not focus a clicked button, so a blur handler cannot detect an outside click.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (e.target instanceof Node && !wrapperRef.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const items = () => Array.from(wrapperRef.current?.querySelectorAll<HTMLButtonElement>("[role='menuitemcheckbox']") ?? []);

  useEffect(() => {
    if (open) items()[0]?.focus();
  }, [open]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const all = items();
    const index = all.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === "Home" ? 0 : e.key === "End" ? all.length - 1 : (index + (e.key === "ArrowDown" ? 1 : -1) + all.length) % all.length;
    all[next]?.focus();
  };

  return (
    <div ref={wrapperRef} className="relative" onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs text-gray-400 hover:text-gray-200 hover:bg-white/[0.06] focus:outline-none focus-visible:ring-1 focus-visible:ring-cyan-500/50"
      >
        <Columns3 className="w-3.5 h-3.5" aria-hidden />
        Columns
        {hidden.length > 0 && <span className="text-gray-600">({hidden.length} hidden)</span>}
      </button>
      {open && (
        <div role="menu" aria-label="Visible columns" className="absolute right-0 mt-1 w-44 z-30 glass rounded-xl border border-white/[0.08] p-1 shadow-2xl">
          {COLUMNS.filter((c) => c.id !== "name").map((c) => {
            const visible = !hidden.includes(c.id);
            return (
              <button
                key={c.id}
                type="button"
                role="menuitemcheckbox"
                aria-checked={visible}
                onClick={() => onToggle(c.id)}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs text-gray-300 text-left hover:bg-white/[0.06] focus:outline-none focus-visible:bg-white/[0.08]"
              >
                <span className="w-3.5 flex-shrink-0">{visible && <Check className="w-3.5 h-3.5 text-cyan-400" aria-hidden />}</span>
                {c.title}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
