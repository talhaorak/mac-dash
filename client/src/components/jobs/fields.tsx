import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  CALENDAR_FIELDS,
  KEEPALIVE_CONDITIONS,
  calendarEntries,
  describeCalendarEntry,
  type KeySpec,
} from "@shared/launchd";
import { isPlistDict, type PlistDict, type PlistValue } from "@shared/plist";
import { ChoosePathButton, type PathPickerMode } from "./PathPicker";
import { PlistTreeEditor, nestedKeyOptionsFor, presetsForKey } from "./PlistTreeEditor";
import {
  DEFAULT_UMASK,
  UMASK_CLASSES,
  UMASK_PERMISSIONS,
  formatMode,
  formatOctal,
  modeUnderUmask,
  normalizeUmask,
  parseUmaskString,
  toggleUmaskBit,
  umaskToGrid,
} from "./umask";

// Input primitives for the launchd job form. Every field edits one plist value and
// reports `undefined` when the key should be removed from the job.

export const inputClass =
  "w-full px-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.08] text-sm text-gray-200 placeholder-gray-600 " +
  "focus:outline-none focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/20 transition-all disabled:opacity-50";

const smallButton =
  "inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs text-gray-400 hover:text-gray-200 hover:bg-white/[0.06] transition-colors disabled:opacity-40";

export function FieldRow({
  label,
  help,
  htmlFor,
  issue,
  jobKey,
  children,
}: {
  label: string;
  help?: string;
  htmlFor?: string;
  issue?: { severity: "error" | "warning" | "info"; message: string } | null;
  /** The plist key of the row. The form finds the row by it, to scroll to a key that was just added. */
  jobKey?: string;
  children: ReactNode;
}) {
  return (
    <div data-job-key={jobKey} className="grid grid-cols-[180px_1fr] gap-x-4 gap-y-1 items-start py-2">
      <label htmlFor={htmlFor} className="text-xs font-medium text-gray-400 pt-2">
        {label}
      </label>
      <div className="min-w-0 space-y-1">
        {children}
        {help && <p className="text-[11px] leading-snug text-gray-600">{help}</p>}
        {issue && (
          <p
            className={cn(
              "text-[11px] leading-snug",
              issue.severity === "error" ? "text-red-400" : issue.severity === "warning" ? "text-amber-400" : "text-gray-500"
            )}
          >
            {issue.severity === "error" ? "Error: " : issue.severity === "warning" ? "Warning: " : ""}
            {issue.message}
          </p>
        )}
      </div>
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative mt-1 h-5 w-9 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/50 disabled:opacity-50",
        checked ? "bg-cyan-500/70" : "bg-white/10"
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white transition-transform",
          checked && "translate-x-4"
        )}
      />
    </button>
  );
}

/** true / false / not set. launchd treats a missing key differently from false for several keys. */
export function TriState({
  value,
  onChange,
  disabled,
  label,
}: {
  value: boolean | undefined;
  onChange: (next: boolean | undefined) => void;
  disabled?: boolean;
  label: string;
}) {
  const options: { v: boolean | undefined; text: string }[] = [
    { v: undefined, text: "Not set" },
    { v: true, text: "True" },
    { v: false, text: "False" },
  ];
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg bg-white/[0.04] p-0.5">
      {options.map((o) => (
        <button
          key={o.text}
          type="button"
          role="radio"
          aria-checked={value === o.v}
          disabled={disabled}
          onClick={() => onChange(o.v)}
          className={cn(
            "px-2.5 py-1 rounded-md text-xs transition-colors",
            value === o.v ? "bg-cyan-500/20 text-cyan-300" : "text-gray-500 hover:text-gray-300"
          )}
        >
          {o.text}
        </button>
      ))}
    </div>
  );
}

export function NumberInput({
  id,
  value,
  onChange,
  min,
  max,
  placeholder,
  disabled,
  className,
  ariaLabel,
}: {
  id?: string;
  value: number | undefined;
  onChange: (next: number | undefined) => void;
  min?: number;
  max?: number;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <input
      id={id}
      type="number"
      inputMode="numeric"
      aria-label={ariaLabel}
      min={min}
      max={max}
      step={1}
      disabled={disabled}
      placeholder={placeholder}
      value={value ?? ""}
      onChange={(e) => {
        const n = e.target.value === "" ? undefined : Math.trunc(Number(e.target.value));
        onChange(n === undefined || Number.isNaN(n) ? undefined : n);
      }}
      className={cn(inputClass, "font-mono", className)}
    />
  );
}

export function StringList({
  values,
  onChange,
  placeholder,
  disabled,
  addLabel = "Add",
  mono = true,
  choose,
  chooseLabel = "Item",
}: {
  values: string[];
  onChange: (next: string[] | undefined) => void;
  placeholder?: string;
  disabled?: boolean;
  addLabel?: string;
  mono?: boolean;
  /** Rows that hold a path get a "Choose…" button: return the picker mode of the row, or null for no button. */
  choose?: (index: number) => PathPickerMode | null;
  /** Name of the list in the accessible name of the buttons, for example "Watch path". */
  chooseLabel?: string;
}) {
  const update = (next: string[]) => onChange(next.length > 0 ? next : undefined);
  return (
    <div className="space-y-1.5">
      {values.map((v, i) => (
        <div key={i} className="flex gap-1.5">
          <input
            type="text"
            aria-label={`Item ${i + 1}`}
            value={v}
            disabled={disabled}
            placeholder={placeholder}
            spellCheck={false}
            onChange={(e) => update(values.map((x, j) => (j === i ? e.target.value : x)))}
            className={cn(inputClass, mono && "font-mono text-xs")}
          />
          {choose?.(i) && (
            <ChoosePathButton
              mode={choose(i)!}
              value={v}
              disabled={disabled}
              fieldLabel={`${chooseLabel} ${i + 1}`}
              onPick={(path) => update(values.map((x, j) => (j === i ? path : x)))}
            />
          )}
          <button
            type="button"
            aria-label={`Remove item ${i + 1}`}
            disabled={disabled}
            onClick={() => update(values.filter((_, j) => j !== i))}
            className={smallButton}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
      <button type="button" disabled={disabled} onClick={() => onChange([...values, ""])} className={smallButton}>
        <Plus className="w-3.5 h-3.5" />
        {addLabel}
      </button>
    </div>
  );
}

/** Dictionary editor. `kind` decides the value widget. */
export function DictEditor({
  value,
  onChange,
  kind,
  keyPlaceholder,
  valuePlaceholder,
  keyOptions,
  disabled,
  addLabel = "Add",
}: {
  value: PlistDict;
  onChange: (next: PlistDict | undefined) => void;
  kind: "string" | "boolean" | "integer";
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  keyOptions?: string[];
  disabled?: boolean;
  addLabel?: string;
}) {
  const listId = useId();
  // Rows live here, not in the dict: while a key is being typed it can be empty or equal
  // another key for a moment, and a dict would silently drop one of the two entries.
  const [entries, setEntries] = useState<[string, PlistValue][]>(() => Object.entries(value));
  const committed = useRef(JSON.stringify(value));
  useEffect(() => {
    const incoming = JSON.stringify(value);
    if (incoming === committed.current) return; // our own commit coming back
    committed.current = incoming;
    setEntries(Object.entries(value));
  }, [value]);

  const commit = (next: [string, PlistValue][]) => {
    setEntries(next);
    const dict = Object.fromEntries(next.filter(([k]) => k !== ""));
    committed.current = JSON.stringify(dict);
    onChange(Object.keys(dict).length > 0 ? dict : undefined);
  };
  const blank: PlistValue = kind === "string" ? "" : kind === "boolean" ? true : 0;
  const keys = entries.map(([k]) => k);
  const duplicates = [...new Set(keys.filter((k, i) => k !== "" && keys.indexOf(k) !== i))];

  return (
    <div className="space-y-1.5">
      {keyOptions && (
        <datalist id={listId}>
          {keyOptions.map((k) => (
            <option key={k} value={k} />
          ))}
        </datalist>
      )}
      {entries.map(([k, v], i) => (
        <div key={i} className="flex gap-1.5 items-center">
          <input
            type="text"
            aria-label={`Key ${i + 1}`}
            list={keyOptions ? listId : undefined}
            value={k}
            disabled={disabled}
            spellCheck={false}
            placeholder={keyPlaceholder}
            onChange={(e) => commit(entries.map((en, j) => (j === i ? [e.target.value, en[1]] : en)))}
            className={cn(inputClass, "font-mono text-xs flex-[2]")}
          />
          {kind === "string" && (
            <input
              type="text"
              aria-label={`Value of ${k || `key ${i + 1}`}`}
              value={typeof v === "string" ? v : ""}
              disabled={disabled}
              spellCheck={false}
              placeholder={valuePlaceholder}
              onChange={(e) => commit(entries.map((en, j) => (j === i ? [en[0], e.target.value] : en)))}
              className={cn(inputClass, "font-mono text-xs flex-[3]")}
            />
          )}
          {kind === "integer" && (
            <NumberInput
              ariaLabel={`Value of ${k || `key ${i + 1}`}`}
              value={typeof v === "number" ? v : undefined}
              disabled={disabled}
              min={0}
              onChange={(n) => commit(entries.map((en, j) => (j === i ? [en[0], n ?? 0] : en)))}
              className="flex-[2] text-xs"
            />
          )}
          {kind === "boolean" && (
            <select
              aria-label={`Value of ${k || `key ${i + 1}`}`}
              value={v === false ? "false" : "true"}
              disabled={disabled}
              onChange={(e) => commit(entries.map((en, j) => (j === i ? [en[0], e.target.value === "true"] : en)))}
              className={cn(inputClass, "flex-1 text-xs")}
            >
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          )}
          <button
            type="button"
            aria-label={`Remove ${k || `entry ${i + 1}`}`}
            disabled={disabled}
            onClick={() => commit(entries.filter((_, j) => j !== i))}
            className={smallButton}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
      {duplicates.length > 0 && (
        <p role="alert" className="text-[11px] text-amber-400">
          Duplicate key: {duplicates.join(", ")}. Only the last one is saved.
        </p>
      )}
      <button
        type="button"
        disabled={disabled || keys.includes("")}
        onClick={() => commit([...entries, ["", blank]])}
        className={smallButton}
      >
        <Plus className="w-3.5 h-3.5" />
        {addLabel}
      </button>
    </div>
  );
}

// ── KeepAlive ────────────────────────────────────────────────────────

export function KeepAliveEditor({
  value,
  onChange,
  disabled,
}: {
  value: PlistValue | undefined;
  onChange: (next: PlistValue | undefined) => void;
  disabled?: boolean;
}) {
  const mode = value === true ? "always" : isPlistDict(value) ? "conditional" : "off";
  const dict = isPlistDict(value) ? value : {};
  const setCondition = (key: string, v: PlistValue | undefined) => {
    const next = { ...dict };
    if (v === undefined) delete next[key];
    else next[key] = v;
    onChange(next);
  };

  return (
    <div className="space-y-2">
      <select
        aria-label="Keep alive mode"
        value={mode}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value === "always" ? true : e.target.value === "conditional" ? {} : undefined)}
        className={cn(inputClass, "max-w-xs")}
      >
        <option value="off">Off: run only when triggered</option>
        <option value="always">Always: restart whenever it exits</option>
        <option value="conditional">Conditional: restart only when…</option>
      </select>

      {mode === "conditional" && (
        <div className="rounded-lg border border-white/[0.06] bg-black/20 p-3 space-y-3">
          {KEEPALIVE_CONDITIONS.filter((c) => !c.deprecated || c.key in dict).map((c) => (
            <div key={c.key} className="space-y-1">
              <div className="flex items-center gap-3">
                <span className="text-xs font-mono text-gray-300 w-40">{c.key}</span>
                {c.type === "boolean" ? (
                  <TriState
                    label={c.key}
                    disabled={disabled}
                    value={typeof dict[c.key] === "boolean" ? (dict[c.key] as boolean) : undefined}
                    onChange={(v) => setCondition(c.key, v)}
                  />
                ) : null}
              </div>
              {c.type === "bool-dict" && (
                <DictEditor
                  kind="boolean"
                  disabled={disabled}
                  value={isPlistDict(dict[c.key]) ? (dict[c.key] as PlistDict) : {}}
                  keyPlaceholder={c.key === "PathState" ? "/path/to/file" : "com.example.other-job"}
                  addLabel={c.key === "PathState" ? "Add path" : "Add job"}
                  onChange={(v) => setCondition(c.key, v)}
                />
              )}
              <p className="text-[11px] text-gray-600">{c.help}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── StartInterval ────────────────────────────────────────────────────

const UNITS = [
  { label: "seconds", factor: 1 },
  { label: "minutes", factor: 60 },
  { label: "hours", factor: 3600 },
  { label: "days", factor: 86400 },
];

export function IntervalEditor({
  value,
  onChange,
  disabled,
}: {
  value: number | undefined;
  onChange: (next: number | undefined) => void;
  disabled?: boolean;
}) {
  const unit = value === undefined ? UNITS[1] : [...UNITS].reverse().find((u) => value % u.factor === 0) ?? UNITS[0];
  return (
    <div className="flex gap-2 items-center">
      <span className="text-xs text-gray-500">Every</span>
      <NumberInput
        ariaLabel="Interval"
        value={value === undefined ? undefined : value / unit.factor}
        min={1}
        disabled={disabled}
        placeholder="off"
        onChange={(n) => onChange(n === undefined || n < 1 ? undefined : n * unit.factor)}
        className="w-24"
      />
      <select
        aria-label="Interval unit"
        value={unit.label}
        disabled={disabled || value === undefined}
        onChange={(e) => {
          const next = UNITS.find((u) => u.label === e.target.value)!;
          if (value !== undefined) onChange((value / unit.factor) * next.factor);
        }}
        className={cn(inputClass, "w-28")}
      >
        {UNITS.map((u) => (
          <option key={u.label}>{u.label}</option>
        ))}
      </select>
      {value !== undefined && <span className="text-[11px] text-gray-600 font-mono">{value} s</span>}
    </div>
  );
}

// ── StartCalendarInterval ────────────────────────────────────────────

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function CalendarEditor({
  value,
  onChange,
  disabled,
}: {
  value: PlistValue | undefined;
  onChange: (next: PlistValue | undefined) => void;
  disabled?: boolean;
}) {
  const entries = calendarEntries(value);
  const commit = (next: PlistDict[]) => onChange(next.length > 0 ? next : undefined);
  const setField = (i: number, field: string, n: number | undefined) =>
    commit(
      entries.map((entry, j) => {
        if (j !== i) return entry;
        const next = { ...entry };
        if (n === undefined) delete next[field];
        else next[field] = n;
        return next;
      })
    );

  const presets: { label: string; build: () => PlistDict[] }[] = [
    { label: "Every day", build: () => [{ Hour: 9, Minute: 0 }] },
    { label: "Weekdays", build: () => [1, 2, 3, 4, 5].map((Weekday) => ({ Weekday, Hour: 9, Minute: 0 })) },
    { label: "Every hour", build: () => [{ Minute: 0 }] },
    { label: "Weekly", build: () => [{ Weekday: 1, Hour: 9, Minute: 0 }] },
    { label: "Monthly", build: () => [{ Day: 1, Hour: 9, Minute: 0 }] },
  ];

  return (
    <div className="space-y-2">
      {entries.map((entry, i) => (
        <div key={i} className="rounded-lg border border-white/[0.06] bg-black/20 p-2.5 space-y-2">
          <div className="flex flex-wrap gap-2 items-end">
            {CALENDAR_FIELDS.map((f) => (
              <label key={f.key} className="space-y-1">
                <span className="block text-[10px] uppercase tracking-wide text-gray-600">{f.key}</span>
                {f.key === "Weekday" ? (
                  <select
                    value={typeof entry.Weekday === "number" ? String(entry.Weekday % 7) : ""}
                    disabled={disabled}
                    onChange={(e) => setField(i, "Weekday", e.target.value === "" ? undefined : Number(e.target.value))}
                    className={cn(inputClass, "w-32 text-xs")}
                  >
                    <option value="">Any</option>
                    {WEEKDAY_NAMES.map((name, d) => (
                      <option key={name} value={d}>
                        {name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <NumberInput
                    value={typeof entry[f.key] === "number" ? (entry[f.key] as number) : undefined}
                    min={f.min}
                    max={f.max}
                    disabled={disabled}
                    placeholder="any"
                    onChange={(n) => setField(i, f.key, n)}
                    className="w-20 text-xs"
                  />
                )}
              </label>
            ))}
            <button
              type="button"
              aria-label={`Remove schedule ${i + 1}`}
              disabled={disabled}
              onClick={() => commit(entries.filter((_, j) => j !== i))}
              className={cn(smallButton, "ml-auto")}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <p className="text-[11px] text-cyan-400/70">Runs {describeCalendarEntry(entry)}</p>
        </div>
      ))}
      <div className="flex flex-wrap gap-1">
        {presets.map((p) => (
          <button
            key={p.label}
            type="button"
            disabled={disabled}
            onClick={() => commit([...entries, ...p.build()])}
            className={smallButton}
          >
            <Plus className="w-3.5 h-3.5" />
            {p.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Session type ─────────────────────────────────────────────────────

export function MultiChoice({
  options,
  value,
  onChange,
  disabled,
}: {
  options: string[];
  value: PlistValue | undefined;
  onChange: (next: PlistValue | undefined) => void;
  disabled?: boolean;
}) {
  const selected = new Set(
    typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []
  );
  return (
    <div className="flex flex-wrap gap-1">
      {options.map((o) => (
        <button
          key={o}
          type="button"
          aria-pressed={selected.has(o)}
          disabled={disabled}
          onClick={() => {
            const next = new Set(selected);
            if (next.has(o)) next.delete(o);
            else next.add(o);
            const list = options.filter((x) => next.has(x));
            onChange(list.length === 0 ? undefined : list.length === 1 ? list[0] : list);
          }}
          className={cn(
            "px-2.5 py-1 rounded-lg text-xs transition-colors",
            selected.has(o) ? "bg-cyan-500/20 text-cyan-300 ring-1 ring-cyan-500/30" : "bg-white/[0.04] text-gray-500 hover:text-gray-300"
          )}
        >
          {o}
        </button>
      ))}
    </div>
  );
}

// ── Umask ────────────────────────────────────────────────────────────

/**
 * Umask as an rwx grid. A checked box MASKS the permission: new files do not get it.
 * The plist stores the decimal integer (octal 022 = 18). launchd also accepts a string,
 * which is shown as it is, with an action that converts it.
 */
export function UmaskEditor({
  value,
  onChange,
  disabled,
}: {
  value: PlistValue | undefined;
  onChange: (next: PlistValue | undefined) => void;
  disabled?: boolean;
}) {
  const groupId = useId();

  // A real, a date or a container is a type error (the Checks panel reports it). The tree editor can change the type.
  if (value !== undefined && typeof value !== "number" && typeof value !== "string") {
    return <PlistTreeEditor name="Umask" value={value} disabled={disabled} onChange={onChange} defaultType="integer" />;
  }

  if (typeof value === "string") {
    const parsed = parseUmaskString(value);
    return (
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <input type="text" readOnly aria-label="Umask (string value)" value={value} className={cn(inputClass, "w-32 font-mono text-xs")} />
          {parsed !== null && (
            <button type="button" disabled={disabled} onClick={() => onChange(normalizeUmask(parsed))} className={smallButton}>
              Convert to integer ({normalizeUmask(parsed)})
            </button>
          )}
          <button type="button" disabled={disabled} onClick={() => onChange(undefined)} className={smallButton}>
            <X className="w-3.5 h-3.5" />
            Remove key
          </button>
        </div>
        <p className="text-[11px] text-gray-600">
          {parsed !== null
            ? `The plist stores a string. launchd reads it as octal ${formatOctal(parsed)}. Convert it to edit the permissions here.`
            : "The plist stores a string that is not a clean number. Edit it in Expert mode, or remove the key."}
        </p>
      </div>
    );
  }

  const isSet = typeof value === "number";
  const mask = isSet ? normalizeUmask(value) : 0;
  const grid = umaskToGrid(mask);
  const outOfRange = isSet && value !== mask;

  return (
    <div className="space-y-2">
      <div role="radiogroup" aria-label="Umask" className="inline-flex rounded-lg bg-white/[0.04] p-0.5">
        {[
          { set: false, text: "Not set" },
          { set: true, text: "Set" },
        ].map((o) => (
          <button
            key={o.text}
            type="button"
            role="radio"
            aria-checked={isSet === o.set}
            disabled={disabled}
            onClick={() => o.set !== isSet && onChange(o.set ? DEFAULT_UMASK : undefined)}
            className={cn(
              "px-2.5 py-1 rounded-md text-xs transition-colors",
              isSet === o.set ? "bg-cyan-500/20 text-cyan-300" : "text-gray-500 hover:text-gray-300"
            )}
          >
            {o.text}
          </button>
        ))}
      </div>

      {isSet && (
        <div className="flex flex-wrap items-start gap-x-6 gap-y-2">
          <table className="text-xs" aria-describedby={`${groupId}-hint`}>
            <caption className="sr-only">Permissions removed from new files</caption>
            <thead>
              <tr>
                <td />
                {UMASK_PERMISSIONS.map((p) => (
                  <th key={p} scope="col" className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-gray-600">
                    {p}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {UMASK_CLASSES.map((cls, c) => (
                <tr key={cls}>
                  <th scope="row" className="pr-3 py-1 text-left font-medium text-gray-400">
                    {cls}
                  </th>
                  {UMASK_PERMISSIONS.map((perm, p) => (
                    <td key={perm} className="px-2 py-1 text-center">
                      <input
                        type="checkbox"
                        aria-label={`Mask ${perm.toLowerCase()} for ${cls.toLowerCase()}`}
                        checked={grid[c][p]}
                        disabled={disabled}
                        onChange={() => onChange(toggleUmaskBit(mask, c, p))}
                        className="h-3.5 w-3.5 rounded accent-cyan-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/50 disabled:opacity-50"
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>

          <dl className="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 text-[11px] text-gray-500" aria-live="polite">
            <dt>Octal</dt>
            <dd className="font-mono text-gray-300">{formatOctal(mask)}</dd>
            <dt>Decimal (stored)</dt>
            <dd className="font-mono text-gray-300">{mask}</dd>
            <dt>New files</dt>
            <dd className="font-mono text-gray-400">
              {formatMode(modeUnderUmask(mask, "file"))} ({modeUnderUmask(mask, "file").toString(8)})
            </dd>
            <dt>New folders</dt>
            <dd className="font-mono text-gray-400">
              {formatMode(modeUnderUmask(mask, "folder"))} ({modeUnderUmask(mask, "folder").toString(8)})
            </dd>
          </dl>
        </div>
      )}

      {isSet && (
        <p id={`${groupId}-hint`} className="text-[11px] text-gray-600">
          A checked box removes that permission from the files the job creates.
        </p>
      )}
      {outOfRange && (
        <p className="text-[11px] text-amber-400">
          The plist stores {String(value)}. umask(2) only uses the nine permission bits, so launchd applies {formatOctal(mask)} (decimal {mask}).
          A change here stores the reduced value.
        </p>
      )}
    </div>
  );
}

/** Keys whose widget is more specific than their schema type. */
const KEY_WIDGETS: Record<
  string,
  (props: { value: PlistValue | undefined; onChange: (next: PlistValue | undefined) => void; disabled?: boolean }) => ReactNode
> = {
  Umask: UmaskEditor,
};

/**
 * Keys that hold one path: the picker mode of their "Choose…" button.
 * `newFile` also offers "use this folder + file name": launchd creates a log file that does not exist yet.
 */
const PATH_KEYS: Record<string, { mode: PathPickerMode; newFile?: string }> = {
  WorkingDirectory: { mode: "folder" },
  RootDirectory: { mode: "folder" },
  StandardOutPath: { mode: "file", newFile: "out.log" },
  StandardErrorPath: { mode: "file", newFile: "err.log" },
  StandardInPath: { mode: "file", newFile: "in.txt" },
};

/** Keys that hold a list of paths. WatchPaths takes files and folders. */
const PATH_LIST_KEYS: Record<string, PathPickerMode> = { WatchPaths: "any", QueueDirectories: "folder" };

/** Pick the widget for a key: a key-specific widget first, else one from its schema type. */
export function SchemaField({
  spec,
  value,
  onChange,
  disabled,
  id,
  jobLabel,
}: {
  spec: KeySpec;
  value: PlistValue | undefined;
  onChange: (next: PlistValue | undefined) => void;
  disabled?: boolean;
  id?: string;
  /** Label of the job: names a new log file and a new Mach service. */
  jobLabel?: string;
}) {
  const KeyWidget = KEY_WIDGETS[spec.key];
  if (KeyWidget) return <KeyWidget value={value} onChange={onChange} disabled={disabled} />;

  switch (spec.type) {
    case "string":
      return spec.options ? (
        <select
          id={id}
          value={typeof value === "string" ? value : ""}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value || undefined)}
          className={cn(inputClass, "max-w-xs")}
        >
          <option value="">Default</option>
          {spec.options.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
      ) : (
        <div className="flex gap-1.5">
          <input
            id={id}
            type="text"
            aria-label={id ? undefined : spec.title}
            spellCheck={false}
            value={typeof value === "string" ? value : ""}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
            className={cn(inputClass, "font-mono text-xs")}
          />
          {PATH_KEYS[spec.key] && (
            <ChoosePathButton
              mode={PATH_KEYS[spec.key].mode}
              value={typeof value === "string" ? value : undefined}
              disabled={disabled}
              fieldLabel={spec.title}
              allowNewFile={PATH_KEYS[spec.key].newFile !== undefined}
              suggestedName={PATH_KEYS[spec.key].newFile ? `${jobLabel || "job"}.${PATH_KEYS[spec.key].newFile}` : undefined}
              onPick={onChange}
            />
          )}
        </div>
      );
    case "integer":
      return (
        <NumberInput
          id={id}
          value={typeof value === "number" ? value : undefined}
          min={spec.min}
          max={spec.max}
          disabled={disabled}
          placeholder="default"
          onChange={onChange}
          className="w-32"
        />
      );
    case "boolean":
      return (
        <TriState
          label={spec.title}
          value={typeof value === "boolean" ? value : undefined}
          disabled={disabled}
          onChange={onChange}
        />
      );
    case "string-array":
      return (
        <StringList
          values={typeof value === "string" ? [value] : Array.isArray(value) ? value.map((v) => (typeof v === "string" ? v : "")) : []}
          disabled={disabled}
          onChange={onChange}
          choose={PATH_LIST_KEYS[spec.key] ? () => PATH_LIST_KEYS[spec.key] : undefined}
          chooseLabel={spec.title}
        />
      );
    case "string-dict":
      return <DictEditor kind="string" value={isPlistDict(value) ? value : {}} disabled={disabled} onChange={onChange} keyPlaceholder="NAME" valuePlaceholder="value" />;
    case "bool-dict":
      return <DictEditor kind="boolean" value={isPlistDict(value) ? value : {}} disabled={disabled} onChange={onChange} />;
    case "integer-dict":
      return <DictEditor kind="integer" value={isPlistDict(value) ? value : {}} keyOptions={spec.options} disabled={disabled} onChange={onChange} keyPlaceholder="Limit" addLabel="Add limit" />;
    case "keepalive":
      return <KeepAliveEditor value={value} disabled={disabled} onChange={onChange} />;
    case "calendar":
      return <CalendarEditor value={value} disabled={disabled} onChange={onChange} />;
    case "session-type":
      return <MultiChoice options={spec.options ?? []} value={value} disabled={disabled} onChange={onChange} />;
    case "complex":
      return (
        <PlistTreeEditor
          name={spec.key}
          value={value}
          disabled={disabled}
          onChange={onChange}
          presets={presetsForKey(spec.key, jobLabel)}
          nestedKeyOptions={nestedKeyOptionsFor(spec.key)}
        />
      );
  }
}
