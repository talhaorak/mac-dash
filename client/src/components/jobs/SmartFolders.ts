/**
 * Smart folders: saved filters for the launchd job list.
 *
 * This module has no React component and no backend import, so the matching engine can be unit-tested.
 * A folder holds rules. Each rule compares one field of a job with a value.
 *
 * Field kinds and option values are technical identifiers and stay fixed regardless of language. Display
 * titles (field names, operator words, option labels, rule problems, built-in folder names) are resolved
 * through the i18n layer at call time: `fieldTitle`, `fieldOptions`, `operatorTitle`, `ruleProblem`, `folderTitle`.
 */

import { JOB_SCOPES, nextRuns, scopeFor } from "@shared/launchd";
import { t, type TKey } from "@/i18n";
import { scopeTitle } from "@/i18n/launchd";
import type { JobMeta } from "@/lib/backend";
import type { ServiceInfo } from "@/stores/app";

// ── Model ────────────────────────────────────────────────────────────

export type RuleField =
  | "label"
  | "program"
  | "trigger"
  | "tag"
  | "scope"
  | "kind"
  | "status"
  | "owner"
  | "disabled"
  | "loaded"
  | "runsAsRoot"
  | "hasSchedule"
  | "runsSoon"
  | "keepAlive"
  | "unreadable"
  | "quarantined"
  | "writable"
  | "lastExitStatus"
  | "launchdKey";

export type RuleOperator = "is" | "isNot" | "contains" | "notContains" | "startsWith" | "eq" | "neq" | "exists" | "notExists";

export interface SmartRule {
  field: RuleField;
  operator: RuleOperator;
  /** Text, an enum value, "true" / "false", or a number as text. Empty for "exists" and "does not exist". */
  value: string;
  /** Only for the "launchdKey" field: the plist key, e.g. "RunAtLoad" or "KeepAlive.SuccessfulExit". */
  key?: string;
}

/** The plist of one job as JSON, as `backend.getJobPlists()` delivers it. */
export type JobPlist = Record<string, unknown>;

export interface SmartFolder {
  id: string;
  /** The name the user typed. For a built-in folder this holds a dictionary key instead: read it through `folderTitle`. */
  name: string;
  match: "all" | "any";
  rules: SmartRule[];
  /** Built-in folders cannot be edited or deleted. */
  builtin?: boolean;
}

export type FieldKind = "text" | "enum" | "boolean" | "number" | "plist";

/** Logic-only shape of a field: kind and option values, none of which change with the language. */
export interface FieldSpec {
  field: RuleField;
  kind: FieldKind;
  /** Values of an enum field. Use `fieldOptions` for the value paired with its display title. */
  options?: { value: string }[];
}

export const RULE_FIELDS: FieldSpec[] = [
  { field: "label", kind: "text" },
  { field: "program", kind: "text" },
  { field: "trigger", kind: "text" },
  { field: "tag", kind: "text" },
  { field: "scope", kind: "enum", options: JOB_SCOPES.map((s) => ({ value: s.category })) },
  { field: "kind", kind: "enum", options: [{ value: "agent" }, { value: "daemon" }] },
  { field: "status", kind: "enum", options: [{ value: "running" }, { value: "stopped" }, { value: "error" }, { value: "unknown" }] },
  { field: "owner", kind: "enum", options: [{ value: "apple" }, { value: "third-party" }] },
  { field: "disabled", kind: "boolean" },
  { field: "loaded", kind: "boolean" },
  { field: "runsAsRoot", kind: "boolean" },
  { field: "hasSchedule", kind: "boolean" },
  { field: "runsSoon", kind: "boolean" },
  { field: "keepAlive", kind: "boolean" },
  { field: "unreadable", kind: "boolean" },
  { field: "quarantined", kind: "boolean" },
  { field: "writable", kind: "boolean" },
  { field: "lastExitStatus", kind: "number" },
  { field: "launchdKey", kind: "plist" },
];

const FIELD_SPEC = new Map(RULE_FIELDS.map((f) => [f.field, f]));

export function fieldSpec(field: RuleField): FieldSpec {
  return FIELD_SPEC.get(field) ?? RULE_FIELDS[0];
}

// ── Display titles ───────────────────────────────────────────────────

const FIELD_TITLE_KEYS: Record<RuleField, TKey> = {
  label: "list.smartFolders.field.label",
  program: "list.smartFolders.field.program",
  trigger: "list.smartFolders.field.trigger",
  tag: "list.smartFolders.field.tag",
  scope: "list.common.scope",
  kind: "common.type",
  status: "common.status",
  owner: "list.smartFolders.field.owner",
  disabled: "status.disabled",
  loaded: "list.smartFolders.field.loaded",
  runsAsRoot: "list.smartFolders.field.runsAsRoot",
  hasSchedule: "list.smartFolders.field.hasSchedule",
  runsSoon: "list.smartFolders.field.runsSoon",
  keepAlive: "list.smartFolders.field.keepAlive",
  unreadable: "list.smartFolders.field.unreadable",
  quarantined: "list.smartFolders.field.quarantined",
  writable: "list.smartFolders.field.writable",
  lastExitStatus: "list.smartFolders.field.lastExitStatus",
  launchdKey: "list.smartFolders.field.launchdKey",
};

/** Display title of a field, in the active language. */
export function fieldTitle(field: RuleField): string {
  return t(FIELD_TITLE_KEYS[field]);
}

const STATIC_OPTION_TITLE_KEYS: Partial<Record<RuleField, Record<string, TKey>>> = {
  kind: { agent: "list.smartFolders.option.agent", daemon: "list.smartFolders.option.daemon" },
  status: { running: "status.running", stopped: "status.stopped", error: "status.error", unknown: "status.unknown" },
  owner: { apple: "list.owner.apple", "third-party": "list.owner.thirdParty" },
};

/** Value/title pairs of an enum field, in the active language. The "scope" options follow the live scope names. */
export function fieldOptions(field: RuleField): { value: string; title: string }[] {
  if (field === "scope") return JOB_SCOPES.map((s) => ({ value: s.category, title: scopeTitle(s.category) }));
  const keys = STATIC_OPTION_TITLE_KEYS[field];
  if (!keys) return [];
  return (fieldSpec(field).options ?? []).map((o) => ({ value: o.value, title: t(keys[o.value] ?? FIELD_TITLE_KEYS[field]) }));
}

const OPERATOR_TITLE_KEYS: Record<RuleOperator, TKey> = {
  is: "list.smartFolders.operator.is",
  isNot: "list.smartFolders.operator.isNot",
  contains: "list.smartFolders.operator.contains",
  notContains: "list.smartFolders.operator.notContains",
  startsWith: "list.smartFolders.operator.startsWith",
  eq: "list.smartFolders.operator.eq",
  neq: "list.smartFolders.operator.neq",
  exists: "list.smartFolders.operator.exists",
  notExists: "list.smartFolders.operator.notExists",
};

const OPERATORS: Record<FieldKind, RuleOperator[]> = {
  text: ["contains", "notContains", "startsWith", "is", "isNot"],
  enum: ["is", "isNot"],
  boolean: ["is", "isNot"],
  number: ["eq", "neq"],
  plist: ["exists", "notExists", "is", "isNot", "contains"],
};

export function operatorsFor(field: RuleField): RuleOperator[] {
  return OPERATORS[fieldSpec(field).kind];
}

/** Title of an operator in the context of a field. A launchd key "equals" a value, a label "is" a value. */
export function operatorTitle(field: RuleField, operator: RuleOperator): string {
  if (fieldSpec(field).kind === "plist" && operator === "is") return t("list.smartFolders.operator.plistEquals");
  if (fieldSpec(field).kind === "plist" && operator === "isNot") return t("list.smartFolders.operator.plistNotEquals");
  return t(OPERATOR_TITLE_KEYS[operator]);
}

/** True for the operators that compare with `value`. "exists" and "does not exist" only look at the key. */
export function operatorTakesValue(operator: RuleOperator): boolean {
  return operator !== "exists" && operator !== "notExists";
}

export const MAX_KEY_LENGTH = 200;

/** True when the rule reads the plist of the job: the caller must load the plists first. */
export function ruleNeedsPlist(rule: Pick<SmartRule, "field">): boolean {
  return rule.field === "launchdKey";
}

export function folderNeedsPlists(folder: Pick<SmartFolder, "rules">): boolean {
  return folder.rules.some(ruleNeedsPlist);
}

/** A valid starting rule for a field: first operator, first choice. */
export function defaultRule(field: RuleField): SmartRule {
  const spec = fieldSpec(field);
  const value = spec.kind === "enum" ? (spec.options?.[0]?.value ?? "") : spec.kind === "boolean" ? "true" : spec.kind === "number" ? "0" : "";
  const rule: SmartRule = { field, operator: OPERATORS[spec.kind][0], value };
  if (spec.kind === "plist") rule.key = "";
  return rule;
}

/** Problem with a rule as a sentence, or null when the rule can run. */
export function ruleProblem(rule: SmartRule): string | null {
  const spec = FIELD_SPEC.get(rule.field);
  if (!spec) return t("list.smartFolders.problem.unknownField");
  if (!OPERATORS[spec.kind].includes(rule.operator)) return t("list.smartFolders.problem.operatorMismatch");
  if (spec.kind === "text" && rule.value.trim() === "") return t("list.smartFolders.problem.enterText");
  if (spec.kind === "enum" && !spec.options?.some((o) => o.value === rule.value)) return t("list.smartFolders.problem.chooseValue");
  if (spec.kind === "boolean" && rule.value !== "true" && rule.value !== "false") return t("list.smartFolders.problem.chooseYesNo");
  if (spec.kind === "number" && (rule.value.trim() === "" || !Number.isInteger(Number(rule.value)))) return t("list.smartFolders.problem.enterWholeNumber");
  if (spec.kind === "plist") {
    const key = rule.key?.trim() ?? "";
    if (key === "") return t("list.smartFolders.problem.enterKey");
    if (key.length > MAX_KEY_LENGTH) return t("list.smartFolders.problem.keyTooLong");
    if (operatorTakesValue(rule.operator) && rule.value.trim() === "") return t("list.smartFolders.problem.enterValue");
  }
  return null;
}

// ── Facts about one job ──────────────────────────────────────────────

export function isAppleService(s: Pick<ServiceInfo, "label" | "plistPath" | "program">): boolean {
  return (
    s.label.startsWith("com.apple.") ||
    s.plistPath?.includes("/System/") === true ||
    s.program?.startsWith("/System/") === true ||
    s.program?.startsWith("/usr/libexec/") === true
  );
}

/** Daemons run as root unless UserName names another account. Agents run as the logged-in user. */
export function runsAsRoot(s: Pick<ServiceInfo, "category" | "userName">): boolean {
  if (s.userName === "root") return true;
  return scopeFor(s.category)?.kind === "daemon" && !s.userName;
}

export function hasSchedule(s: Pick<ServiceInfo, "startInterval" | "calendar">): boolean {
  return s.startInterval !== null || s.calendar.length > 0;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** True for a StartInterval job, and for a calendar entry whose next start is at most 24 hours after `now`. */
export function runsWithinDay(s: Pick<ServiceInfo, "startInterval" | "calendar">, now: Date): boolean {
  if (s.startInterval !== null) return true;
  const limit = now.getTime() + DAY_MS;
  return s.calendar.some((entry) => {
    const next = nextRuns(entry, now, 1, 2)[0];
    return next !== undefined && next.getTime() <= limit;
  });
}

// ── Matching ─────────────────────────────────────────────────────────

function textValues(field: RuleField, s: ServiceInfo, meta: JobMeta | undefined): string[] {
  switch (field) {
    case "label":
      return [s.label];
    case "program":
      return s.program ? [s.program] : [];
    case "trigger":
      return s.triggers;
    case "tag":
      return meta?.tags ?? [];
    default:
      return [];
  }
}

function enumValue(field: RuleField, s: ServiceInfo): string {
  switch (field) {
    case "scope":
      return s.category;
    case "kind":
      return scopeFor(s.category)?.kind ?? "";
    case "status":
      return s.status;
    case "owner":
      return isAppleService(s) ? "apple" : "third-party";
    default:
      return "";
  }
}

function booleanValue(field: RuleField, s: ServiceInfo, now: Date): boolean {
  switch (field) {
    case "disabled":
      return s.disabled;
    case "loaded":
      return s.loaded;
    case "runsAsRoot":
      return runsAsRoot(s);
    case "hasSchedule":
      return hasSchedule(s);
    case "runsSoon":
      return runsWithinDay(s, now);
    case "keepAlive":
      return s.triggers.some((trig) => trig.includes("Keep alive"));
    case "unreadable":
      return s.unreadable;
    case "quarantined":
      return s.quarantined;
    case "writable":
      return s.writable;
    default:
      return false;
  }
}

// ── launchd keys ─────────────────────────────────────────────────────

const isDict = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Value of a key in a plist. Order: the exact top-level key, the same key without regard to case,
 * then a dotted path into a dictionary ("KeepAlive.SuccessfulExit", "MachServices.com.example.service").
 */
export function lookupPlistKey(plist: JobPlist, key: string): { found: boolean; value: unknown } {
  if (Object.hasOwn(plist, key)) return { found: true, value: plist[key] };
  const lower = key.toLowerCase();
  const sameName = Object.keys(plist).find((k) => k.toLowerCase() === lower);
  if (sameName !== undefined) return { found: true, value: plist[sameName] };
  // Every dot can be the border, because a nested key can hold dots itself.
  for (let dot = key.indexOf("."); dot !== -1; dot = key.indexOf(".", dot + 1)) {
    const head = lookupPlistKey(plist, key.slice(0, dot));
    if (head.found && isDict(head.value)) {
      const rest = lookupPlistKey(head.value, key.slice(dot + 1));
      if (rest.found) return rest;
    }
  }
  return { found: false, value: undefined };
}

const MAX_PLIST_DEPTH = 6;

/**
 * The texts that a rule value is compared with. Booleans are "true" / "false" and numbers are decimal text.
 * An array gives the texts of its elements. A dictionary gives its keys, the texts of its values, and "key=value" pairs.
 */
export function plistTexts(value: unknown, depth = 0): string[] {
  if (typeof value === "string") return [value];
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (depth >= MAX_PLIST_DEPTH) return [];
  if (Array.isArray(value)) return value.flatMap((v) => plistTexts(v, depth + 1));
  if (!isDict(value)) return [];
  return Object.entries(value).flatMap(([k, v]) => {
    const nested = plistTexts(v, depth + 1);
    const scalar = typeof v === "string" || typeof v === "number" || typeof v === "boolean";
    return scalar ? [k, ...nested, `${k}=${nested[0]}`] : [k, ...nested];
  });
}

/**
 * One launchd-key rule against one plist.
 * `undefined` means that the plists are not loaded: nothing is known, so nothing matches.
 * `null` means that the job has no readable plist: no key exists.
 */
function matchesPlistRule(rule: SmartRule, plist: JobPlist | null | undefined): boolean {
  if (plist === undefined) return false;
  const { found, value } = plist === null ? { found: false, value: undefined } : lookupPlistKey(plist, rule.key!.trim());
  if (rule.operator === "exists") return found;
  if (rule.operator === "notExists") return !found;
  const needle = rule.value.trim().toLowerCase();
  const texts = found ? plistTexts(value).map((txt) => txt.toLowerCase()) : [];
  switch (rule.operator) {
    case "is":
      return texts.some((txt) => txt === needle);
    case "isNot":
      return !texts.some((txt) => txt === needle);
    case "contains":
      return texts.some((txt) => txt.includes(needle));
    default:
      return false;
  }
}

/** One rule against one job. A rule that cannot run (see `ruleProblem`) matches nothing. `plist`: see `matchesFolder`. */
export function matchesRule(service: ServiceInfo, meta: JobMeta | undefined, rule: SmartRule, now: Date, plist?: JobPlist | null): boolean {
  if (ruleProblem(rule) !== null) return false;
  const kind = fieldSpec(rule.field).kind;

  if (kind === "plist") return matchesPlistRule(rule, plist);

  if (kind === "text") {
    const needle = rule.value.trim().toLowerCase();
    const values = textValues(rule.field, service, meta).map((v) => v.toLowerCase());
    switch (rule.operator) {
      case "contains":
        return values.some((v) => v.includes(needle));
      case "notContains":
        return !values.some((v) => v.includes(needle));
      case "startsWith":
        return values.some((v) => v.startsWith(needle));
      case "is":
        return values.some((v) => v === needle);
      case "isNot":
        return !values.some((v) => v === needle);
      default:
        return false;
    }
  }

  if (kind === "enum") {
    const equal = enumValue(rule.field, service) === rule.value;
    return rule.operator === "is" ? equal : !equal;
  }

  if (kind === "boolean") {
    const equal = booleanValue(rule.field, service, now) === (rule.value === "true");
    return rule.operator === "is" ? equal : !equal;
  }

  // Number. A job that never exited has no status: it matches neither "=" nor "≠".
  if (service.lastExitStatus === null) return false;
  const equal = service.lastExitStatus === Number(rule.value);
  return rule.operator === "eq" ? equal : !equal;
}

/**
 * True when the job belongs to the folder.
 * `meta` is the notes-and-tags record of this job. `now` anchors the "runs in the next 24 hours" field.
 * `plist` is the plist of this job for the launchd-key rules: leave it out while the plists are not loaded
 * (such a rule then matches nothing), pass `null` for a job without a readable plist.
 * A folder without rules matches every job.
 */
export function matchesFolder(service: ServiceInfo, meta: JobMeta | undefined, folder: SmartFolder, now: Date, plist?: JobPlist | null): boolean {
  if (folder.rules.length === 0) return true;
  const test = (rule: SmartRule) => matchesRule(service, meta, rule, now, plist);
  return folder.match === "any" ? folder.rules.some(test) : folder.rules.every(test);
}

// ── Built-in folders ─────────────────────────────────────────────────

/** Dictionary keys used as the `name` of a built-in folder. `folderTitle` resolves them at render time. */
const BUILTIN_FOLDER_NAMES = {
  disabled: "status.disabled",
  failed: "list.smartFolders.builtin.failed",
  thirdPartyDaemons: "list.smartFolders.builtin.thirdPartyDaemons",
  scheduledToday: "list.smartFolders.builtin.scheduledToday",
} as const satisfies Record<string, TKey>;

export const DEFAULT_FOLDERS: SmartFolder[] = [
  { id: "builtin:disabled", name: BUILTIN_FOLDER_NAMES.disabled, match: "all", builtin: true, rules: [{ field: "disabled", operator: "is", value: "true" }] },
  { id: "builtin:failed", name: BUILTIN_FOLDER_NAMES.failed, match: "all", builtin: true, rules: [{ field: "status", operator: "is", value: "error" }] },
  {
    id: "builtin:third-party-daemons",
    name: BUILTIN_FOLDER_NAMES.thirdPartyDaemons,
    match: "all",
    builtin: true,
    rules: [
      { field: "owner", operator: "is", value: "third-party" },
      { field: "kind", operator: "is", value: "daemon" },
    ],
  },
  {
    id: "builtin:scheduled-today",
    name: BUILTIN_FOLDER_NAMES.scheduledToday,
    match: "all",
    builtin: true,
    rules: [
      { field: "runsSoon", operator: "is", value: "true" },
      { field: "disabled", operator: "is", value: "false" },
    ],
  },
];

/** Display name of a folder: the user's own text, or the translated name of a built-in folder. */
export function folderTitle(folder: Pick<SmartFolder, "name" | "builtin">): string {
  return folder.builtin ? t(folder.name as TKey) : folder.name;
}

// ── Persistence of the user's folders ────────────────────────────────

export const SMART_FOLDERS_KEY = "macdash.smartFolders";
const MAX_FOLDERS = 50;
const MAX_RULES = 20;

/** Keep only well-formed folders. The input comes from localStorage and is untrusted. */
export function sanitizeFolders(input: unknown): SmartFolder[] {
  if (!Array.isArray(input)) return [];
  const folders: SmartFolder[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== "object" || raw === null) continue;
    const { id, name, match, rules } = raw as Record<string, unknown>;
    if (typeof id !== "string" || id === "" || id.startsWith("builtin:") || seen.has(id)) continue;
    if (typeof name !== "string" || name.trim() === "" || !Array.isArray(rules)) continue;
    const cleanRules: SmartRule[] = [];
    for (const r of rules) {
      if (typeof r !== "object" || r === null) continue;
      const rule = r as Record<string, unknown>;
      if (typeof rule.field !== "string" || typeof rule.operator !== "string" || typeof rule.value !== "string") continue;
      const candidate = { field: rule.field, operator: rule.operator, value: rule.value } as SmartRule;
      if (typeof rule.key === "string" && rule.field === "launchdKey") candidate.key = rule.key;
      if (ruleProblem(candidate) === null) cleanRules.push(candidate);
    }
    seen.add(id);
    folders.push({ id, name: name.trim().slice(0, 60), match: match === "any" ? "any" : "all", rules: cleanRules.slice(0, MAX_RULES) });
    if (folders.length === MAX_FOLDERS) break;
  }
  return folders;
}

export function loadUserFolders(): SmartFolder[] {
  try {
    return sanitizeFolders(JSON.parse(localStorage.getItem(SMART_FOLDERS_KEY) ?? "[]"));
  } catch {
    return [];
  }
}

export function saveUserFolders(folders: SmartFolder[]): void {
  try {
    localStorage.setItem(SMART_FOLDERS_KEY, JSON.stringify(folders.filter((f) => !f.builtin)));
  } catch {
    // Private mode or a full quota: the folders stay for this session only.
  }
}

export function newFolderId(): string {
  return `user:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
