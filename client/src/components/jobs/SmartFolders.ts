/**
 * Smart folders: saved filters for the launchd job list.
 *
 * This module has no React and no backend import, so the matching engine can be unit-tested.
 * A folder holds rules. Each rule compares one field of a job with a value.
 */

import { JOB_SCOPES, nextRuns, scopeFor } from "@shared/launchd";
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
  | "lastExitStatus";

export type RuleOperator = "is" | "isNot" | "contains" | "notContains" | "startsWith" | "eq" | "neq";

export interface SmartRule {
  field: RuleField;
  operator: RuleOperator;
  /** Text, an enum value, "true" / "false", or a number as text. */
  value: string;
}

export interface SmartFolder {
  id: string;
  name: string;
  match: "all" | "any";
  rules: SmartRule[];
  /** Built-in folders cannot be edited or deleted. */
  builtin?: boolean;
}

export type FieldKind = "text" | "enum" | "boolean" | "number";

export interface FieldSpec {
  field: RuleField;
  title: string;
  kind: FieldKind;
  /** Choices of an enum field. */
  options?: { value: string; title: string }[];
}

export const RULE_FIELDS: FieldSpec[] = [
  { field: "label", title: "Label", kind: "text" },
  { field: "program", title: "Program", kind: "text" },
  { field: "trigger", title: "Trigger text", kind: "text" },
  { field: "tag", title: "Tag", kind: "text" },
  { field: "scope", title: "Scope", kind: "enum", options: JOB_SCOPES.map((s) => ({ value: s.category, title: s.title })) },
  {
    field: "kind",
    title: "Kind",
    kind: "enum",
    options: [
      { value: "agent", title: "Agent" },
      { value: "daemon", title: "Daemon" },
    ],
  },
  {
    field: "status",
    title: "Status",
    kind: "enum",
    options: [
      { value: "running", title: "Running" },
      { value: "stopped", title: "Stopped" },
      { value: "error", title: "Error" },
      { value: "unknown", title: "Unknown" },
    ],
  },
  {
    field: "owner",
    title: "Owner",
    kind: "enum",
    options: [
      { value: "apple", title: "Apple" },
      { value: "third-party", title: "Third party" },
    ],
  },
  { field: "disabled", title: "Disabled", kind: "boolean" },
  { field: "loaded", title: "Loaded", kind: "boolean" },
  { field: "runsAsRoot", title: "Runs as root", kind: "boolean" },
  { field: "hasSchedule", title: "Has a schedule", kind: "boolean" },
  { field: "runsSoon", title: "Runs in the next 24 hours", kind: "boolean" },
  { field: "keepAlive", title: "Keep alive", kind: "boolean" },
  { field: "unreadable", title: "Unreadable plist", kind: "boolean" },
  { field: "quarantined", title: "Quarantined", kind: "boolean" },
  { field: "writable", title: "Writable", kind: "boolean" },
  { field: "lastExitStatus", title: "Last exit status", kind: "number" },
];

const FIELD_SPEC = new Map(RULE_FIELDS.map((f) => [f.field, f]));

export function fieldSpec(field: RuleField): FieldSpec {
  return FIELD_SPEC.get(field) ?? RULE_FIELDS[0];
}

export const OPERATOR_TITLES: Record<RuleOperator, string> = {
  is: "is",
  isNot: "is not",
  contains: "contains",
  notContains: "does not contain",
  startsWith: "starts with",
  eq: "=",
  neq: "≠",
};

const OPERATORS: Record<FieldKind, RuleOperator[]> = {
  text: ["contains", "notContains", "startsWith", "is", "isNot"],
  enum: ["is", "isNot"],
  boolean: ["is", "isNot"],
  number: ["eq", "neq"],
};

export function operatorsFor(field: RuleField): RuleOperator[] {
  return OPERATORS[fieldSpec(field).kind];
}

/** A valid starting rule for a field: first operator, first choice. */
export function defaultRule(field: RuleField): SmartRule {
  const spec = fieldSpec(field);
  const value = spec.kind === "enum" ? (spec.options?.[0]?.value ?? "") : spec.kind === "boolean" ? "true" : spec.kind === "number" ? "0" : "";
  return { field, operator: OPERATORS[spec.kind][0], value };
}

/** Problem with a rule as a sentence, or null when the rule can run. */
export function ruleProblem(rule: SmartRule): string | null {
  const spec = FIELD_SPEC.get(rule.field);
  if (!spec) return "The field is unknown.";
  if (!OPERATORS[spec.kind].includes(rule.operator)) return "The operator does not fit the field.";
  if (spec.kind === "text" && rule.value.trim() === "") return "Enter a text.";
  if (spec.kind === "enum" && !spec.options?.some((o) => o.value === rule.value)) return "Choose a value.";
  if (spec.kind === "boolean" && rule.value !== "true" && rule.value !== "false") return "Choose yes or no.";
  if (spec.kind === "number" && (rule.value.trim() === "" || !Number.isInteger(Number(rule.value)))) return "Enter a whole number.";
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
      return s.triggers.some((t) => t.includes("Keep alive"));
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

/** One rule against one job. A rule that cannot run (see `ruleProblem`) matches nothing. */
export function matchesRule(service: ServiceInfo, meta: JobMeta | undefined, rule: SmartRule, now: Date): boolean {
  if (ruleProblem(rule) !== null) return false;
  const kind = fieldSpec(rule.field).kind;

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
 * A folder without rules matches every job.
 */
export function matchesFolder(service: ServiceInfo, meta: JobMeta | undefined, folder: SmartFolder, now: Date): boolean {
  if (folder.rules.length === 0) return true;
  const test = (rule: SmartRule) => matchesRule(service, meta, rule, now);
  return folder.match === "any" ? folder.rules.some(test) : folder.rules.every(test);
}

// ── Built-in folders ─────────────────────────────────────────────────

export const DEFAULT_FOLDERS: SmartFolder[] = [
  { id: "builtin:disabled", name: "Disabled", match: "all", builtin: true, rules: [{ field: "disabled", operator: "is", value: "true" }] },
  { id: "builtin:failed", name: "Failed", match: "all", builtin: true, rules: [{ field: "status", operator: "is", value: "error" }] },
  {
    id: "builtin:third-party-daemons",
    name: "Third-party daemons",
    match: "all",
    builtin: true,
    rules: [
      { field: "owner", operator: "is", value: "third-party" },
      { field: "kind", operator: "is", value: "daemon" },
    ],
  },
  {
    id: "builtin:scheduled-today",
    name: "Scheduled today",
    match: "all",
    builtin: true,
    rules: [
      { field: "runsSoon", operator: "is", value: "true" },
      { field: "disabled", operator: "is", value: "false" },
    ],
  },
];

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
