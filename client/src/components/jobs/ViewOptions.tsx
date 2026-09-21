import { useEffect, useRef, useState } from "react";
import { Check, SlidersHorizontal } from "lucide-react";

// ── Options ──────────────────────────────────────────────────────────

export const VIEW_OPTIONS_KEY = "macdash.viewOptions";

/** Parts of the Services page that the user can hide. `true` means visible. */
export interface ViewOptions {
  statusFilter: boolean;
  ownerFilter: boolean;
  tagFilter: boolean;
  smartFolders: boolean;
  startupCard: boolean;
  powerCard: boolean;
}

export type ViewOptionId = keyof ViewOptions;

export const VIEW_OPTION_ITEMS: { id: ViewOptionId; title: string }[] = [
  { id: "statusFilter", title: "Status filter" },
  { id: "ownerFilter", title: "Owner filter" },
  { id: "tagFilter", title: "Tag filter" },
  { id: "smartFolders", title: "Smart folder bar" },
  { id: "startupCard", title: "Other startup mechanisms" },
  { id: "powerCard", title: "Power schedule" },
];

export const DEFAULT_VIEW_OPTIONS: ViewOptions = {
  statusFilter: true,
  ownerFilter: true,
  tagFilter: true,
  smartFolders: true,
  startupCard: true,
  powerCard: true,
};

/** Only an explicit `false` hides a part. The input comes from localStorage and is untrusted. */
export function sanitizeViewOptions(input: unknown): ViewOptions {
  const raw = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const options = { ...DEFAULT_VIEW_OPTIONS };
  for (const { id } of VIEW_OPTION_ITEMS) options[id] = raw[id] !== false;
  return options;
}

export function loadViewOptions(): ViewOptions {
  try {
    return sanitizeViewOptions(JSON.parse(localStorage.getItem(VIEW_OPTIONS_KEY) ?? "{}"));
  } catch {
    return { ...DEFAULT_VIEW_OPTIONS };
  }
}

export function saveViewOptions(options: ViewOptions): void {
  try {
    localStorage.setItem(VIEW_OPTIONS_KEY, JSON.stringify(options));
  } catch {
    // Private mode or a full quota: the options stay for this session only.
  }
}

// ── Menu ─────────────────────────────────────────────────────────────

export interface ViewOptionsMenuProps {
  value: ViewOptions;
  /** Receives the complete new set. The owner stores it (see `saveViewOptions`). */
  onChange: (options: ViewOptions) => void;
}

/** Menu button that shows and hides the parts of the Services page. Arrow keys move, Escape closes. */
export function ViewOptionsMenu({ value, onChange }: ViewOptionsMenuProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const hiddenCount = VIEW_OPTION_ITEMS.filter((item) => !value[item.id]).length;

  // Safari does not focus a clicked button, so a blur handler cannot detect an outside click.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (e.target instanceof Node && !wrapperRef.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const items = () => Array.from(wrapperRef.current?.querySelectorAll<HTMLButtonElement>("[role^='menuitem']:not([disabled])") ?? []);

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
    if (e.key === "Tab") {
      setOpen(false);
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const all = items();
    const index = all.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "Home" ? 0 : e.key === "End" ? all.length - 1 : (index + (e.key === "ArrowDown" ? 1 : -1) + all.length) % all.length;
    all[next]?.focus();
  };

  const itemClass =
    "w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs text-gray-300 text-left hover:bg-white/[0.06] focus:outline-none focus-visible:bg-white/[0.08] disabled:opacity-40";

  return (
    <div ref={wrapperRef} className="relative" onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        title="Show or hide parts of this page"
        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium text-gray-300 bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] focus:outline-none focus-visible:ring-1 focus-visible:ring-cyan-500/50"
      >
        <SlidersHorizontal className="w-3.5 h-3.5" aria-hidden />
        View options
        {hiddenCount > 0 && <span className="text-gray-500">({hiddenCount} hidden)</span>}
      </button>
      {open && (
        <div role="menu" aria-label="Visible parts of the Services page" className="absolute right-0 mt-1 w-60 z-40 glass rounded-xl border border-white/[0.08] p-1 shadow-2xl">
          {VIEW_OPTION_ITEMS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitemcheckbox"
              aria-checked={value[item.id]}
              onClick={() => onChange({ ...value, [item.id]: !value[item.id] })}
              className={itemClass}
            >
              <span className="w-3.5 flex-shrink-0">{value[item.id] && <Check className="w-3.5 h-3.5 text-cyan-400" aria-hidden />}</span>
              {item.title}
            </button>
          ))}
          <div role="separator" className="my-1 border-t border-white/[0.06]" />
          <button type="button" role="menuitem" disabled={hiddenCount === 0} onClick={() => onChange({ ...DEFAULT_VIEW_OPTIONS })} className={itemClass}>
            <span className="w-3.5 flex-shrink-0" />
            Show everything
          </button>
        </div>
      )}
    </div>
  );
}
