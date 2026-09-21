import { useId, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { PlistData, PlistReal, isPlistDict, serializePlist, type PlistDict, type PlistValue } from "@shared/plist";
import { t, tn, type TKey } from "@/i18n";

// Recursive editor for any property list value. The form uses it for the nested launchd keys
// (Sockets, MachServices, LaunchEvents…) and for keys it has no schema for.
// The first half of this file is pure and unit-tested (helpers.test.ts). The components follow.

// ── Types and conversion ─────────────────────────────────────────────

export const PLIST_TYPES = ["string", "integer", "real", "boolean", "date", "data", "array", "dict"] as const;
export type PlistType = (typeof PLIST_TYPES)[number];

// Kept in English: JobForm.tsx renders this map directly (`PLIST_TYPE_LABELS[t]`), outside this
// file's scope. `plistTypeLabel()` below is the localised equivalent used within this file.
export const PLIST_TYPE_LABELS: Record<PlistType, string> = {
  string: "String",
  integer: "Integer",
  real: "Real",
  boolean: "Boolean",
  date: "Date",
  data: "Data",
  array: "Array",
  dict: "Dictionary",
};

const PLIST_TYPE_LABEL_KEYS: Record<PlistType, TKey> = {
  string: "fields.plistTree.type.string",
  integer: "fields.plistTree.type.integer",
  real: "fields.plistTree.type.real",
  boolean: "fields.plistTree.type.boolean",
  date: "fields.plistTree.type.date",
  data: "fields.plistTree.type.data",
  array: "fields.plistTree.type.array",
  dict: "fields.plistTree.type.dict",
};

/** Localised display name of a plist type, for use within this file. */
function plistTypeLabel(type: PlistType): string {
  return t(PLIST_TYPE_LABEL_KEYS[type]);
}

/** Containers deeper than this are shown as XML and edited in Expert mode. The root value has depth 0. */
export const MAX_TREE_DEPTH = 12;

export function plistTypeOf(value: PlistValue): PlistType {
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "real";
  if (value instanceof PlistReal) return "real";
  if (value instanceof Date) return "date";
  if (value instanceof PlistData) return "data";
  return Array.isArray(value) ? "array" : "dict";
}

const isContainer = (value: PlistValue): value is PlistValue[] | PlistDict => Array.isArray(value) || isPlistDict(value);

/** Property list dates have no milliseconds. */
function wholeSeconds(date: Date): Date {
  return new Date(Math.floor(date.getTime() / 1000) * 1000);
}

export function defaultForType(type: PlistType, now: Date = new Date()): PlistValue {
  switch (type) {
    case "string":
      return "";
    case "integer":
      return 0;
    case "real":
      return new PlistReal(0);
    case "boolean":
      return true;
    case "date":
      return wholeSeconds(now);
    case "data":
      return new PlistData("");
    case "array":
      return [];
    case "dict":
      return {};
  }
}

/** The text a scalar shows in its input. Containers have no text. */
export function scalarText(value: PlistValue): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof PlistReal) return String(value.value);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toISOString().replace(/\.\d{3}Z$/, "Z");
  if (value instanceof PlistData) return value.base64;
  return "";
}

const INTEGER_TEXT = /^[+-]?\d+$/;
const REAL_TEXT = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
/** A full UTC or offset time, or a date alone (UTC). A time without a zone is ambiguous and is refused. */
const DATE_TEXT = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2}))?$/;
const BASE64_TEXT = /^[A-Za-z0-9+/]*={0,2}$/;

/** Parse what the user typed for a scalar type. Returns null when the text is not a value of that type. */
export function parseScalarText(type: PlistType, text: string): PlistValue | null {
  const t = text.trim();
  switch (type) {
    case "string":
      return text;
    case "integer": {
      if (!INTEGER_TEXT.test(t)) return null;
      const n = Number(t);
      return Number.isSafeInteger(n) ? n : null;
    }
    case "real": {
      if (!REAL_TEXT.test(t)) return null;
      const n = parseFloat(t);
      return Number.isFinite(n) ? new PlistReal(n) : null;
    }
    case "boolean":
      return t === "true" ? true : t === "false" ? false : null;
    case "date": {
      if (!DATE_TEXT.test(t)) return null;
      const d = new Date(t);
      return Number.isNaN(d.getTime()) ? null : wholeSeconds(d);
    }
    case "data": {
      const compact = text.replace(/\s+/g, "");
      return BASE64_TEXT.test(compact) && compact.length % 4 === 0 ? new PlistData(compact) : null;
    }
    default:
      return null;
  }
}

/** Decoded size of a base64 text. */
export function base64Bytes(base64: string): number {
  const compact = base64.replace(/\s+/g, "");
  if (compact === "") return 0;
  const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((compact.length * 3) / 4) - padding);
}

/** Change the type of a value and keep as much of it as the new type can hold. */
export function convertValue(value: PlistValue, to: PlistType, now: Date = new Date()): PlistValue {
  const from = plistTypeOf(value);
  if (from === to) return value;

  if (to === "array") {
    if (isPlistDict(value)) return Object.values(value);
    return from === "string" && value === "" ? [] : [value];
  }
  if (to === "dict") {
    if (Array.isArray(value)) return Object.fromEntries(value.map((item, i) => [`item${i + 1}`, item]));
    return {};
  }
  if (isContainer(value)) {
    // A container with one scalar gives that scalar. Everything else has no meaningful scalar form.
    const items = Array.isArray(value) ? value : Object.values(value);
    return items.length === 1 && !isContainer(items[0]) ? convertValue(items[0], to, now) : defaultForType(to, now);
  }

  if (to === "string") return scalarText(value);
  if (to === "boolean") {
    if (typeof value === "string") return /^(true|yes|1)$/i.test(value.trim());
    if (typeof value === "number") return value !== 0;
    if (value instanceof PlistReal) return value.value !== 0;
    return defaultForType(to, now);
  }
  if (to === "integer" || to === "real") {
    const n =
      typeof value === "boolean"
        ? Number(value)
        : value instanceof Date
          ? Math.floor(value.getTime() / 1000)
          : value instanceof PlistData
            ? Number.NaN
            : parseFloat(scalarText(value));
    if (!Number.isFinite(n)) return defaultForType(to, now);
    return to === "integer" ? Math.trunc(n) : new PlistReal(n);
  }
  // date, data
  return parseScalarText(to, scalarText(value)) ?? defaultForType(to, now);
}

/** Exact identity of a value, types included (JSON cannot tell a date from a string, or a real from a dictionary). */
export function plistSignature(value: PlistValue | undefined): string {
  return value === undefined ? "" : serializePlist(value);
}

export function describeContainer(value: PlistValue[] | PlistDict): string {
  const n = Array.isArray(value) ? value.length : Object.keys(value).length;
  return Array.isArray(value) ? tn("fields.plistTree.items", n) : tn("fields.plistTree.entries", n);
}

// ── Rows ─────────────────────────────────────────────────────────────

/**
 * One line of a container. Rows live in component state, not in the value: while a key is being typed it can be
 * empty or equal another key for a moment, and a dictionary would silently drop one of the two entries.
 * `id` is stable for the life of the row: React keeps the row's state when rows move.
 */
export interface TreeRow {
  id: number;
  key: string;
  value: PlistValue;
}

let rowCounter = 0;
export const nextRowId = () => ++rowCounter;

export function rowsFromValue(value: PlistValue[] | PlistDict, newId: () => number = nextRowId): TreeRow[] {
  if (Array.isArray(value)) return value.map((item) => ({ id: newId(), key: "", value: item }));
  return Object.entries(value).map(([key, v]) => ({ id: newId(), key, value: v }));
}

/** Rows without a key are not saved. For a duplicate key the last row wins, as in a property list parser. */
export function dictFromRows(rows: TreeRow[]): PlistDict {
  return Object.fromEntries(rows.filter((r) => r.key !== "").map((r) => [r.key, r.value]));
}

export const arrayFromRows = (rows: TreeRow[]): PlistValue[] => rows.map((r) => r.value);

export function duplicateRowKeys(rows: TreeRow[]): string[] {
  const keys = rows.map((r) => r.key);
  return [...new Set(keys.filter((k, i) => k !== "" && keys.indexOf(k) !== i))];
}

/**
 * Rows for a value that changed outside the component (undo, Expert mode). Ids of the old rows are kept where the
 * key (dictionary) or the position (array) is the same, so an open row stays open.
 */
export function reconcileRows(previous: TreeRow[], value: PlistValue[] | PlistDict, newId: () => number = nextRowId): TreeRow[] {
  if (Array.isArray(value)) return value.map((item, i) => ({ id: previous[i]?.id ?? newId(), key: "", value: item }));
  const byKey = new Map(previous.map((r) => [r.key, r.id]));
  const used = new Set<number>();
  return Object.entries(value).map(([key, v]) => {
    const known = byKey.get(key);
    const id = known !== undefined && !used.has(known) ? known : newId();
    used.add(id);
    return { id, key, value: v };
  });
}

export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/** "Listeners", "Listeners2", "Listeners3"… */
export function uniqueKey(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) if (!used.has(`${base}${i}`)) return `${base}${i}`;
}

// ── Presets for launchd keys ─────────────────────────────────────────

/** Keys of one socket dictionary, launchd.plist(5). */
export const SOCKET_KEYS = [
  "SockType",
  "SockPassive",
  "SockNodeName",
  "SockServiceName",
  "SockFamily",
  "SockProtocol",
  "SockPathName",
  "SecureSocketWithKey",
  "SockPathMode",
  "Bonjour",
  "MulticastGroup",
];

export interface TreePreset {
  label: string;
  /** Returns the new value of the key. `current` is undefined when the key is not set. */
  apply: (current: PlistValue | undefined) => PlistValue;
}

const asDict = (current: PlistValue | undefined): PlistDict => (isPlistDict(current) ? current : {});

export function presetsForKey(key: string, jobLabel?: string): TreePreset[] {
  switch (key) {
    case "Sockets":
      return [
        {
          label: t("fields.plistTree.preset.addSocket"),
          apply: (current) => {
            const dict = asDict(current);
            return { ...dict, [uniqueKey("Listeners", Object.keys(dict))]: { SockServiceName: "8080", SockType: "stream", SockFamily: "IPv4" } };
          },
        },
      ];
    case "MachServices":
      return [
        {
          label: t("fields.plistTree.preset.addService"),
          apply: (current) => {
            const dict = asDict(current);
            return { ...dict, [uniqueKey(jobLabel?.trim() || "com.example.service", Object.keys(dict))]: true };
          },
        },
      ];
    case "LaunchEvents":
      return [
        {
          label: t("fields.plistTree.preset.addIokitEvent"),
          apply: (current) => {
            const dict = asDict(current);
            const stream = asDict(dict["com.apple.iokit.matching"]);
            return {
              ...dict,
              "com.apple.iokit.matching": {
                ...stream,
                [uniqueKey("com.example.device-attached", Object.keys(stream))]: {
                  IOProviderClass: "IOUSBDevice",
                  idVendor: 1452,
                  idProduct: 4779,
                  IOMatchLaunchStream: true,
                },
              },
            };
          },
        },
      ];
    case "inetdCompatibility":
      return [{ label: t("fields.plistTree.preset.addWait"), apply: (current) => ({ Wait: false, ...asDict(current) }) }];
    default:
      return [];
  }
}

/** Key suggestions for the dictionaries below the root value of a launchd key. */
export function nestedKeyOptionsFor(key: string): string[] | undefined {
  return key === "Sockets" ? SOCKET_KEYS : undefined;
}

// ── Components ───────────────────────────────────────────────────────

const treeInput =
  "min-w-0 px-2 py-1 rounded-md bg-white/[0.04] border border-white/[0.08] text-xs text-gray-200 placeholder-gray-600 font-mono " +
  "focus:outline-none focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/20 transition-all disabled:opacity-50";

const treeButton =
  "inline-flex items-center gap-1 px-1.5 py-1 rounded-md text-xs text-gray-400 hover:text-gray-200 hover:bg-white/[0.06] transition-colors " +
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/50 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-gray-400";

const SCALAR_HINT_KEYS: Partial<Record<PlistType, TKey>> = {
  integer: "fields.plistTree.hint.integer",
  real: "fields.plistTree.hint.real",
  date: "fields.plistTree.hint.date",
  data: "fields.plistTree.hint.data",
};

function scalarHint(type: PlistType): string | undefined {
  const key = SCALAR_HINT_KEYS[type];
  return key === undefined ? undefined : t(key);
}

function xmlPreview(value: PlistValue): string {
  return serializePlist(value).split("\n").slice(3, -2).join("\n");
}

function TypeSelect({
  value,
  onChange,
  depth,
  disabled,
  label,
}: {
  value: PlistValue;
  onChange: (next: PlistValue) => void;
  depth: number;
  disabled?: boolean;
  label: string;
}) {
  const type = plistTypeOf(value);
  // A container cannot be created where it could not be edited.
  const types = PLIST_TYPES.filter((pt) => pt === type || depth < MAX_TREE_DEPTH || (pt !== "array" && pt !== "dict"));
  return (
    <select
      data-tree-type
      aria-label={label}
      value={type}
      disabled={disabled}
      onChange={(e) => onChange(convertValue(value, e.target.value as PlistType))}
      className={cn(treeInput, "w-[6.5rem] flex-shrink-0 font-sans")}
    >
      {types.map((pt) => (
        <option key={pt} value={pt}>
          {plistTypeLabel(pt)}
        </option>
      ))}
    </select>
  );
}

function ScalarInput({
  value,
  onChange,
  disabled,
  label,
}: {
  value: PlistValue;
  onChange: (next: PlistValue) => void;
  disabled?: boolean;
  label: string;
}) {
  const type = plistTypeOf(value);
  const canonical = scalarText(value);
  const hintId = useId();
  // `committed` is the text of the last value this input reported. Another text means the value changed outside.
  const [draft, setDraft] = useState({ text: canonical, committed: canonical });
  let current = draft;
  if (type !== "string" && type !== "boolean" && draft.committed !== canonical) {
    current = { text: canonical, committed: canonical };
    setDraft(current);
  }

  if (type === "boolean") {
    return (
      <select
        data-tree-value
        aria-label={label}
        value={value === true ? "true" : "false"}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value === "true")}
        className={cn(treeInput, "flex-[3] basis-24 font-sans")}
      >
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  }

  if (type === "string") {
    return (
      <input
        type="text"
        data-tree-value
        aria-label={label}
        value={canonical}
        disabled={disabled}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        className={cn(treeInput, "flex-[3] basis-24")}
      />
    );
  }

  const invalid = parseScalarText(type, current.text) === null;
  const edit = (text: string) => {
    const parsed = parseScalarText(type, text);
    if (parsed === null) return setDraft({ text, committed: current.committed });
    setDraft({ text, committed: scalarText(parsed) });
    onChange(parsed);
  };

  return (
    <span className="flex-[3] basis-24 min-w-0 space-y-0.5">
      <input
        type="text"
        data-tree-value
        inputMode={type === "integer" ? "numeric" : type === "real" ? "decimal" : undefined}
        aria-label={label}
        aria-invalid={invalid}
        aria-describedby={invalid ? hintId : undefined}
        value={current.text}
        disabled={disabled}
        spellCheck={false}
        placeholder={type === "date" ? "2026-01-31T09:00:00Z" : type === "data" ? "base64" : undefined}
        onChange={(e) => edit(e.target.value)}
        // The job keeps the last valid value. Do not leave another text on screen.
        onBlur={() => invalid && setDraft({ text: canonical, committed: canonical })}
        className={cn(treeInput, "w-full", invalid && "border-amber-500/60 focus:border-amber-500/60 focus:ring-amber-500/20")}
      />
      {invalid ? (
        <span id={hintId} role="alert" className="block text-[11px] text-amber-400">
          {t("fields.plistTree.notSaved", { hint: scalarHint(type) ?? "" })}
        </span>
      ) : type === "data" ? (
        <span className="block text-[11px] text-gray-600">{tn("fields.plistTree.bytes", base64Bytes(canonical))}</span>
      ) : null}
    </span>
  );
}

interface NodeProps {
  value: PlistValue;
  onChange: (next: PlistValue) => void;
  /** Depth of `value`. The root value has depth 0. */
  depth: number;
  disabled?: boolean;
  /** Accessible name of this value, for example "Sockets, Listeners". */
  name: string;
  /** Key suggestions for this dictionary, and for the dictionaries below it. */
  keyOptions?: string[];
  childKeyOptions?: string[];
}

/** Rows of a container, kept in step with the value (see TreeRow). */
function useRows(value: PlistValue[] | PlistDict, onChange: (next: PlistValue) => void): [TreeRow[], (rows: TreeRow[]) => void] {
  const isArray = Array.isArray(value);
  const signature = useMemo(() => plistSignature(value), [value]);
  const [state, setState] = useState(() => ({ signature, rows: rowsFromValue(value) }));
  let current = state;
  if (state.signature !== signature) {
    // Not our own commit coming back: the value changed outside (undo, a preset, Expert mode).
    current = { signature, rows: reconcileRows(state.rows, value) };
    setState(current);
  }
  const commit = (rows: TreeRow[]) => {
    const next = isArray ? arrayFromRows(rows) : dictFromRows(rows);
    setState({ signature: plistSignature(next), rows });
    onChange(next);
  };
  return [current.rows, commit];
}

function ContainerNode({ value, onChange, depth, disabled, name, keyOptions, childKeyOptions }: NodeProps & { value: PlistValue[] | PlistDict }) {
  const isArray = Array.isArray(value);
  const listId = useId();
  const root = useRef<HTMLDivElement>(null);
  const [rows, commit] = useRows(value, onChange);
  const duplicates = isArray ? [] : duplicateRowKeys(rows);
  const hasEmptyKey = !isArray && rows.some((r) => r.key === "");

  /** Focus the first control that one of the selectors finds in THIS container, after React has placed the rows. */
  const focusLater = (...selectors: string[]) =>
    requestAnimationFrame(() => {
      for (const selector of selectors) {
        for (const el of root.current?.querySelectorAll<HTMLElement>(selector) ?? []) {
          if (el.closest("[data-tree-container]") === root.current && !(el as HTMLButtonElement).disabled) return el.focus();
        }
      }
    });

  const setRow = (id: number, patch: Partial<TreeRow>) => commit(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const add = () => {
    const last = rows[rows.length - 1];
    // A new array item takes the type of the item before it: arrays are homogeneous in practice.
    const initial: PlistValue = isArray && last ? defaultForType(plistTypeOf(last.value)) : "";
    const row: TreeRow = { id: nextRowId(), key: "", value: isContainer(initial) && depth + 1 >= MAX_TREE_DEPTH ? "" : initial };
    commit([...rows, row]);
    const within = `[data-tree-row="${row.id}"]`;
    focusLater(`${within} [data-tree-key]`, `${within} [data-tree-value]`, `${within} [data-tree-type]`);
  };

  const remove = (id: number) => {
    commit(rows.filter((r) => r.id !== id));
    focusLater("[data-tree-add]");
  };

  const move = (index: number, direction: -1 | 1) => {
    const id = rows[index].id;
    commit(moveItem(rows, index, index + direction));
    // The pressed button can be disabled at the new position: then the other direction takes the focus.
    const within = `[data-tree-row="${id}"]`;
    focusLater(`${within} [data-move="${direction === -1 ? "up" : "down"}"]`, `${within} [data-move="${direction === -1 ? "down" : "up"}"]`);
  };

  return (
    <div ref={root} data-tree-container className="space-y-1.5">
      {!isArray && keyOptions && keyOptions.length > 0 && (
        <datalist id={listId}>
          {keyOptions.map((k) => (
            <option key={k} value={k} />
          ))}
        </datalist>
      )}

      {rows.length === 0 && (
        <p className="text-[11px] text-gray-600">{isArray ? t("fields.plistTree.emptyArray") : t("fields.plistTree.emptyDict")}</p>
      )}

      {rows.map((row, i) => (
        <RowView
          key={row.id}
          row={row}
          index={i}
          count={rows.length}
          isArray={isArray}
          depth={depth + 1}
          disabled={disabled}
          parentName={name}
          listId={!isArray && keyOptions && keyOptions.length > 0 ? listId : undefined}
          childKeyOptions={childKeyOptions}
          onKey={(key) => setRow(row.id, { key })}
          onValue={(v) => setRow(row.id, { value: v })}
          onRemove={() => remove(row.id)}
          onMove={(direction) => move(i, direction)}
        />
      ))}

      {duplicates.length > 0 && (
        <p role="alert" className="text-[11px] text-amber-400">
          {t("fields.common.duplicateKey", { keys: duplicates.join(", ") })}
        </p>
      )}

      <button type="button" data-tree-add disabled={disabled || hasEmptyKey} onClick={add} className={treeButton}>
        <Plus className="w-3.5 h-3.5" aria-hidden />
        {isArray ? t("fields.plistTree.addItem") : t("fields.plistTree.addEntry")}
      </button>
    </div>
  );
}

function RowView({
  row,
  index,
  count,
  isArray,
  depth,
  disabled,
  parentName,
  listId,
  childKeyOptions,
  onKey,
  onValue,
  onRemove,
  onMove,
}: {
  row: TreeRow;
  index: number;
  count: number;
  isArray: boolean;
  /** Depth of the row's value. */
  depth: number;
  disabled?: boolean;
  parentName: string;
  listId?: string;
  childKeyOptions?: string[];
  onKey: (key: string) => void;
  onValue: (value: PlistValue) => void;
  onRemove: () => void;
  onMove: (direction: -1 | 1) => void;
}) {
  const container = isContainer(row.value);
  const [open, setOpen] = useState(depth <= 3);
  const bodyId = useId();
  const shortName = isArray
    ? t("fields.plistTree.itemIndex", { index: index + 1 })
    : row.key || t("fields.plistTree.entryIndex", { index: index + 1 });
  const name = `${parentName}, ${shortName}`;

  return (
    <div data-tree-row={row.id} className="space-y-1.5">
      <div className="flex flex-wrap items-start gap-1.5">
        {container ? (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={bodyId}
            aria-label={t(open ? "fields.plistTree.collapse" : "fields.plistTree.expand", { name })}
            onClick={() => setOpen(!open)}
            className={cn(treeButton, "px-0.5")}
          >
            {open ? <ChevronDown className="w-3.5 h-3.5" aria-hidden /> : <ChevronRight className="w-3.5 h-3.5" aria-hidden />}
          </button>
        ) : (
          <span className="w-[18px] flex-shrink-0" aria-hidden />
        )}

        {isArray ? (
          <span className="w-6 flex-shrink-0 pt-1.5 text-right text-[11px] font-mono text-gray-600" aria-hidden>
            {index + 1}
          </span>
        ) : (
          <input
            type="text"
            data-tree-key
            aria-label={t("fields.plistTree.keyOfParent", { index: index + 1, parent: parentName })}
            aria-invalid={row.key === ""}
            list={listId}
            value={row.key}
            disabled={disabled}
            spellCheck={false}
            placeholder={t("fields.plistTree.keyPlaceholder")}
            onChange={(e) => onKey(e.target.value)}
            className={cn(treeInput, "flex-[2] basis-24")}
          />
        )}

        <TypeSelect value={row.value} depth={depth} disabled={disabled} label={t("fields.plistTree.typeOf", { name })} onChange={onValue} />

        {container ? (
          <span className="flex-[3] basis-24 pt-1.5 text-[11px] text-gray-500">{describeContainer(row.value as PlistValue[] | PlistDict)}</span>
        ) : (
          <ScalarInput value={row.value} disabled={disabled} label={t("fields.common.valueOf", { name })} onChange={onValue} />
        )}

        <span className="flex flex-shrink-0">
          {isArray && (
            <>
              <button
                type="button"
                data-move="up"
                aria-label={t("fields.plistTree.moveUp", { name })}
                disabled={disabled || index === 0}
                onClick={() => onMove(-1)}
                className={treeButton}
              >
                <ArrowUp className="w-3.5 h-3.5" aria-hidden />
              </button>
              <button
                type="button"
                data-move="down"
                aria-label={t("fields.plistTree.moveDown", { name })}
                disabled={disabled || index === count - 1}
                onClick={() => onMove(1)}
                className={treeButton}
              >
                <ArrowDown className="w-3.5 h-3.5" aria-hidden />
              </button>
            </>
          )}
          <button type="button" aria-label={t("fields.common.removeNamed", { name })} disabled={disabled} onClick={onRemove} className={treeButton}>
            <X className="w-3.5 h-3.5" aria-hidden />
          </button>
        </span>
      </div>

      {container && open && (
        <div id={bodyId} role="group" aria-label={name} className="ml-2 pl-3 border-l border-white/[0.08]">
          <TreeNode value={row.value} onChange={onValue} depth={depth} disabled={disabled} name={name} keyOptions={childKeyOptions} childKeyOptions={childKeyOptions} />
        </div>
      )}
    </div>
  );
}

function TreeNode(props: NodeProps) {
  const { value, depth } = props;
  if (!isContainer(value)) {
    return <ScalarInput value={value} disabled={props.disabled} label={t("fields.common.valueOf", { name: props.name })} onChange={props.onChange} />;
  }
  if (depth >= MAX_TREE_DEPTH) {
    return (
      <div className="space-y-1">
        <pre className="max-h-40 overflow-auto rounded-lg bg-black/30 p-2 text-[11px] font-mono text-gray-400">{xmlPreview(value)}</pre>
        <p className="text-[11px] text-gray-600">{t("fields.plistTree.tooDeep", { depth: MAX_TREE_DEPTH })}</p>
      </div>
    );
  }
  return <ContainerNode {...props} value={value} />;
}

/**
 * Editor for one plist value of any type. `value` undefined means the key is not set.
 * `onChange(undefined)` removes the key.
 */
export function PlistTreeEditor({
  name,
  value,
  onChange,
  disabled,
  presets = [],
  keyOptions,
  nestedKeyOptions,
  defaultType = "dict",
}: {
  /** The plist key, for accessible names. */
  name: string;
  value: PlistValue | undefined;
  onChange: (next: PlistValue | undefined) => void;
  disabled?: boolean;
  presets?: TreePreset[];
  /** Key suggestions for the root dictionary, and for the dictionaries below it. */
  keyOptions?: string[];
  nestedKeyOptions?: string[];
  /** Type of the value that "Add" creates when the key is not set. */
  defaultType?: PlistType;
}) {
  // Every preset adds to a dictionary. It must not replace a value of another type.
  const presetsFit = value === undefined || isPlistDict(value);
  const presetButtons = presets.map((p) => (
    <button key={p.label} type="button" disabled={disabled || !presetsFit} onClick={() => onChange(p.apply(value))} className={treeButton}>
      <Plus className="w-3.5 h-3.5" aria-hidden />
      {p.label}
    </button>
  ));

  if (value === undefined) {
    return (
      <div className="flex flex-wrap items-center gap-1 pt-1">
        <span className="pr-1 text-[11px] text-gray-600">{t("fields.plistTree.notSet")}</span>
        {presetButtons}
        <button type="button" disabled={disabled} onClick={() => onChange(defaultForType(defaultType))} className={treeButton}>
          <Plus className="w-3.5 h-3.5" aria-hidden />
          {t("fields.plistTree.addEmpty", { type: plistTypeLabel(defaultType).toLowerCase() })}
        </button>
      </div>
    );
  }

  const container = isContainer(value);
  return (
    <div role="group" aria-label={t("fields.plistTree.valueGroupLabel", { name })} className="rounded-lg border border-white/[0.06] bg-black/20 p-2.5 space-y-2">
      <div className="flex flex-wrap items-start gap-1.5">
        <TypeSelect value={value} depth={0} disabled={disabled} label={t("fields.plistTree.typeOf", { name })} onChange={onChange} />
        {container ? (
          <span className="pt-1.5 text-[11px] text-gray-500">{describeContainer(value)}</span>
        ) : (
          <ScalarInput value={value} disabled={disabled} label={t("fields.common.valueOf", { name })} onChange={onChange} />
        )}
        <span className="ml-auto flex flex-wrap gap-1">
          {presetButtons}
          <button type="button" disabled={disabled} onClick={() => onChange(undefined)} className={treeButton}>
            <X className="w-3.5 h-3.5" aria-hidden />
            {t("fields.common.removeKey")}
          </button>
        </span>
      </div>
      {container && (
        <TreeNode value={value} onChange={onChange} depth={0} disabled={disabled} name={name} keyOptions={keyOptions} childKeyOptions={nestedKeyOptions} />
      )}
    </div>
  );
}
