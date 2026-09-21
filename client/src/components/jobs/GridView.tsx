import { memo, useId, useMemo, useRef, useState } from "react";
import { Lock, ShieldAlert } from "lucide-react";
import { GlowCard } from "@/components/ui/GlowCard";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { metaKey, type JobMeta } from "@/lib/backend";
import type { ServiceInfo } from "@/stores/app";
import { cn } from "@/lib/utils";
import { formatNumber, t, useT, type TKey } from "@/i18n";
import { localizeTriggers } from "@/i18n/launchd";
import { JobIcon } from "./JobIcon";
import { serviceKey } from "./ListJobRowActions";

// ── Tile size ────────────────────────────────────────────────────────

export const GRID_TILE_SIZES = ["small", "medium", "large"] as const;
export type GridTileSize = (typeof GRID_TILE_SIZES)[number];

const STORAGE_KEY = "macdash.gridTileSize";

const SIZE_SPEC: Record<GridTileSize, { minWidth: number; icon: number; tile: string; label: string }> = {
  small: { minWidth: 128, icon: 28, tile: "p-2.5 gap-1.5", label: "text-[11px]" },
  medium: { minWidth: 172, icon: 40, tile: "p-3 gap-2", label: "text-[12px]" },
  large: { minWidth: 228, icon: 56, tile: "p-4 gap-2.5", label: "text-[13px]" },
};

const SIZE_TITLE_KEYS: Record<GridTileSize, TKey> = {
  small: "list.grid.sizeSmall",
  medium: "list.grid.sizeMedium",
  large: "list.grid.sizeLarge",
};

function sizeTitle(size: GridTileSize): string {
  return t(SIZE_TITLE_KEYS[size]);
}

const STATUS_WORD_KEYS: Record<ServiceInfo["status"], TKey> = {
  running: "status.running",
  stopped: "status.stopped",
  error: "status.error",
  unknown: "status.unknown",
};

function loadTileSize(): GridTileSize {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return GRID_TILE_SIZES.includes(stored as GridTileSize) ? (stored as GridTileSize) : "medium";
  } catch {
    return "medium";
  }
}

function saveTileSize(size: GridTileSize): void {
  try {
    localStorage.setItem(STORAGE_KEY, size);
  } catch {
    // Private mode or a full quota: the size stays for this session only.
  }
}

// ── View ─────────────────────────────────────────────────────────────

/** Tiles rendered per step. The list holds about 1000 jobs. */
const WINDOW = 300;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export interface JobGridViewProps {
  /** Jobs after search, filters and smart folder. */
  services: ServiceInfo[];
  /** Notes, tags and icons by `metaKey`. */
  meta: Record<string, JobMeta>;
  /** True while the first job list is still on its way. */
  loading: boolean;
  /** Opens the detail drawer. Receives the `serviceKey` of the job. */
  onSelect: (key: string) => void;
}

/**
 * Grid of job tiles, sorted by label. The tile size comes from a slider and stays in localStorage (`macdash.gridTileSize`).
 * Keyboard: Tab reaches one tile, the arrow keys move between tiles, Home and End go to the ends of a row,
 * Ctrl or Cmd with Home and End go to the first and the last tile.
 */
export function JobGridView({ services, meta, loading, onSelect }: JobGridViewProps) {
  const { t, tn } = useT();
  const hintId = useId();
  const gridRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(loadTileSize);
  const [limit, setLimit] = useState(WINDOW);
  /** The one tile that Tab reaches. It follows the focus. */
  const [activeKey, setActiveKey] = useState<string | null>(null);

  const sorted = useMemo(() => [...services].sort((a, b) => collator.compare(a.label, b.label) || collator.compare(a.category, b.category)), [services]);
  const rows = sorted.slice(0, limit);
  const tabbableKey = activeKey !== null && rows.some((s) => serviceKey(s) === activeKey) ? activeKey : rows.length > 0 ? serviceKey(rows[0]) : null;

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // Cmd+Left and Cmd+Right belong to the browser history.
    if (e.altKey || (e.metaKey && e.key.startsWith("Arrow"))) return;
    const toEnds = e.ctrlKey || e.metaKey;
    const tiles = Array.from(gridRef.current?.querySelectorAll<HTMLButtonElement>("button[data-tile]") ?? []);
    const index = tiles.indexOf(document.activeElement as HTMLButtonElement);
    if (index === -1) return;
    // The browser lays the columns out. The first row tells how many there are.
    const columns = Math.max(1, tiles.filter((tile) => tile.offsetTop === tiles[0].offsetTop).length);
    const rowStart = index - (index % columns);
    const last = tiles.length - 1;
    let next: number;
    switch (e.key) {
      case "ArrowRight":
        next = Math.min(index + 1, last);
        break;
      case "ArrowLeft":
        next = Math.max(index - 1, 0);
        break;
      case "ArrowDown":
        // From the row above a short last row, go to its last tile.
        next = index + columns <= last ? index + columns : rowStart + columns <= last ? last : index;
        break;
      case "ArrowUp":
        next = index - columns >= 0 ? index - columns : index;
        break;
      case "Home":
        next = toEnds ? 0 : rowStart;
        break;
      case "End":
        next = toEnds ? last : Math.min(rowStart + columns - 1, last);
        break;
      default:
        return;
    }
    e.preventDefault();
    tiles[next]?.focus();
  };

  if (loading && services.length === 0) return <p className="text-sm text-gray-500 text-center py-10">{t("list.status.readingLaunchd")}</p>;
  if (services.length === 0) return <p className="text-sm text-gray-500 text-center py-10">{t("list.status.noMatch")}</p>;

  const spec = SIZE_SPEC[size];

  return (
    <GlowCard padding="sm">
      <div className="flex items-center gap-3 px-2 pb-2 flex-wrap">
        <p className="text-xs text-gray-500 flex-1" aria-live="polite">
          {rows.length < sorted.length
            ? tn("list.count.shownOfTotal", sorted.length, { shown: formatNumber(rows.length) })
            : tn("list.count.jobs", sorted.length)}
        </p>
        <label className="inline-flex items-center gap-2 text-xs text-gray-500">
          {t("list.grid.tileSizeLabel")}
          <input
            type="range"
            min={0}
            max={GRID_TILE_SIZES.length - 1}
            step={1}
            value={GRID_TILE_SIZES.indexOf(size)}
            aria-valuetext={sizeTitle(size)}
            onChange={(e) => {
              const next = GRID_TILE_SIZES[Number(e.target.value)] ?? "medium";
              setSize(next);
              saveTileSize(next);
            }}
            className="w-24 accent-cyan-400 cursor-pointer rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/60"
          />
          <span className="w-12 text-gray-400">{sizeTitle(size)}</span>
        </label>
      </div>

      <p id={hintId} className="sr-only">
        {t("list.grid.hint")}
      </p>
      <div
        ref={gridRef}
        role="group"
        aria-label={t("list.grid.ariaLabel")}
        aria-describedby={hintId}
        onKeyDown={onKeyDown}
        className="grid gap-2"
        style={{ gridTemplateColumns: `repeat(auto-fill, minmax(min(${spec.minWidth}px, 100%), 1fr))` }}
      >
        {rows.map((service) => {
          const key = serviceKey(service);
          return (
            <JobTile key={key} service={service} icon={meta[metaKey(service)]?.icon} size={size} tabbable={key === tabbableKey} onSelect={onSelect} onFocusTile={setActiveKey} />
          );
        })}
      </div>

      {sorted.length > rows.length && (
        <button
          type="button"
          onClick={() => setLimit((n) => n + WINDOW)}
          className="w-full mt-2 py-2 text-xs text-cyan-400 hover:bg-white/[0.03] rounded-lg focus:outline-none focus-visible:ring-1 focus-visible:ring-cyan-500/50"
        >
          {tn("list.count.showMore", Math.min(WINDOW, sorted.length - rows.length))} ({t("list.count.hiddenTotal", { count: formatNumber(sorted.length - rows.length) })})
        </button>
      )}
    </GlowCard>
  );
}

// ── Tile ─────────────────────────────────────────────────────────────

/** "Every 5 minutes +2" for a job with three triggers. */
function triggerSummary(service: ServiceInfo): string {
  if (service.triggers.length === 0) return service.plistPath ? t("list.grid.onDemand") : t("list.grid.noPlistFile");
  const [first, ...rest] = localizeTriggers(service.triggers);
  return rest.length === 0 ? first : t("list.grid.triggerPlusMore", { first, count: formatNumber(rest.length) });
}

const JobTile = memo(function JobTile({
  service,
  icon,
  size,
  tabbable,
  onSelect,
  onFocusTile,
}: {
  service: ServiceInfo;
  icon: string | undefined;
  size: GridTileSize;
  tabbable: boolean;
  onSelect: (key: string) => void;
  onFocusTile: (key: string) => void;
}) {
  const { t } = useT();
  const spec = SIZE_SPEC[size];
  const key = serviceKey(service);
  const flaw = service.unreadable ? t("list.badge.unreadableShort") : service.quarantined ? t("list.badge.quarantinedShort") : null;
  const stateWord = service.disabled ? t("status.disabled") : t(STATUS_WORD_KEYS[service.status]);
  const name = [service.label, stateWord, !service.writable && t("list.grid.readOnlyInline"), flaw].filter(Boolean).join(", ");

  return (
    <button
      type="button"
      data-tile
      tabIndex={tabbable ? 0 : -1}
      aria-label={t("list.actions.openDetailsAria", { text: name })}
      title={service.label}
      onClick={() => onSelect(key)}
      onFocus={() => onFocusTile(key)}
      className={cn(
        "min-w-0 flex flex-col text-left rounded-xl border border-white/[0.05] bg-white/[0.02] transition-colors",
        "hover:bg-white/[0.05] hover:border-white/[0.1] focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/60",
        spec.tile,
        service.disabled && "opacity-55"
      )}
    >
      <span className="flex items-start gap-1.5 w-full min-w-0">
        <JobIcon label={service.label} icon={icon} size={spec.icon} />
        <span className="ml-auto flex items-center gap-1 flex-wrap justify-end min-w-0">
          {flaw && (
            <span title={service.unreadable ? t("list.badge.unreadableTitle") : t("list.badge.quarantinedTitle")} className="text-red-400">
              <ShieldAlert className="w-3.5 h-3.5" aria-hidden />
            </span>
          )}
          {!service.writable && (
            <span title={t("list.common.readOnly")} className="inline-flex items-center justify-center w-4 h-4 rounded bg-white/[0.06] text-gray-400">
              <Lock className="w-2.5 h-2.5" aria-hidden />
            </span>
          )}
          {service.disabled && <span className="px-1.5 py-px rounded text-[9px] font-medium bg-amber-500/15 text-amber-400">{t("status.disabled")}</span>}
        </span>
      </span>

      <span className={cn("w-full font-mono font-medium text-gray-200 break-all line-clamp-2 leading-snug", spec.label)}>{service.label}</span>

      <span className="mt-auto w-full min-w-0 space-y-0.5">
        <span className="block">
          <StatusBadge status={service.status} size="sm" />
        </span>
        <span className="block truncate text-[10px] text-cyan-500/70">{triggerSummary(service)}</span>
      </span>
    </button>
  );
});
