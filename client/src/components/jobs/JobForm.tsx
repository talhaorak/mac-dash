import { useEffect, useId, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Wand2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { backend } from "@/lib/backend";
import {
  KEY_SPEC,
  LAUNCHD_KEYS,
  scopeFor,
  type JobCategory,
  type JobIssue,
  type KeyGroup,
  type KeySpec,
} from "@shared/launchd";
import { type PlistDict, type PlistValue } from "@shared/plist";
import { ComplexValue, FieldRow, SchemaField, StringList, Toggle, inputClass } from "./fields";

// Form view of a launchd job. It edits the same PlistDict that Expert mode serializes,
// so keys the form does not know are preserved.

export function setKey(job: PlistDict, key: string, value: PlistValue | undefined): PlistDict {
  if (value === undefined) {
    const { [key]: _removed, ...rest } = job;
    return rest;
  }
  return { ...job, [key]: value };
}

// ── What to run ──────────────────────────────────────────────────────

type RunKind = "command" | "program" | "script" | "app" | "shortcut";

const SHELLS = ["/bin/sh", "/bin/bash", "/bin/zsh"];
const INTERPRETERS = [...SHELLS, "/usr/bin/python3", "/usr/bin/ruby", "/usr/bin/perl", "/usr/bin/osascript", "/usr/bin/swift"];
const SEARCH_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin", "/opt/homebrew/sbin", "/usr/local/sbin"];
export const DEFAULT_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

const RUN_KINDS: { kind: RunKind; title: string; hint: string }[] = [
  { kind: "command", title: "Command", hint: "A shell command line. Runs through sh -c, so pipes, && and variables work." },
  { kind: "program", title: "Program", hint: "An executable and its arguments, passed to launchd as they are." },
  { kind: "script", title: "Script", hint: "A script file, run by the interpreter you choose." },
  { kind: "app", title: "App", hint: "Opens an application with /usr/bin/open." },
  { kind: "shortcut", title: "Shortcut", hint: "Runs a shortcut from the Shortcuts app." },
];

function argsOf(job: PlistDict): string[] {
  return Array.isArray(job.ProgramArguments) ? job.ProgramArguments.map((a) => (typeof a === "string" ? a : "")) : [];
}

function detectRunKind(job: PlistDict): RunKind {
  const a = argsOf(job);
  if (typeof job.Program === "string") return "program";
  if (a.length === 3 && SHELLS.includes(a[0]) && a[1] === "-c") return "command";
  if (a[0] === "/usr/bin/open" && a[1] === "-a") return "app";
  if (a[0] === "/usr/bin/shortcuts" && a[1] === "run" && a.length === 3) return "shortcut";
  if (a.length === 2 && INTERPRETERS.includes(a[0]) && a[1].startsWith("/")) return "script";
  return "program";
}

function RunSection({
  job,
  onChange,
  disabled,
  issueFor,
}: {
  job: PlistDict;
  onChange: (next: PlistDict) => void;
  disabled?: boolean;
  issueFor: (key: string) => JobIssue | null;
}) {
  const [kind, setKind] = useState<RunKind>(() => detectRunKind(job));
  const [shortcuts, setShortcuts] = useState<string[]>([]);
  const [resolveNote, setResolveNote] = useState<string | null>(null);
  const shortcutListId = useId();
  const args = argsOf(job);
  const setArgs = (next: string[]) => onChange(setKey(setKey(job, "Program", undefined), "ProgramArguments", next));

  useEffect(() => {
    if (kind === "shortcut" && shortcuts.length === 0) backend.listShortcuts().then(setShortcuts).catch(() => {});
  }, [kind, shortcuts.length]);

  const switchKind = (next: RunKind) => {
    setKind(next);
    setResolveNote(null);
    if (next === detectRunKind(job)) return;
    const commandLine = kind === "command" ? args[2] ?? "" : args.join(" ");
    if (next === "command") setArgs(["/bin/sh", "-c", commandLine]);
    else if (next === "program") setArgs(kind === "command" && commandLine ? commandLine.split(/\s+/) : args);
    else if (next === "script") setArgs(["/bin/sh", ""]);
    else if (next === "app") setArgs(["/usr/bin/open", "-a", ""]);
    else setArgs(["/usr/bin/shortcuts", "run", ""]);
  };

  /** "php" → "/usr/bin/php": launchd does not search the login shell's PATH. */
  const resolveExecutable = async () => {
    const exe = args[0];
    if (!exe || exe.includes("/")) return;
    const facts = await backend.checkPaths(SEARCH_DIRS.map((d) => `${d}/${exe}`));
    const hit = SEARCH_DIRS.map((d) => `${d}/${exe}`).find((p) => facts.some((f) => f.path === p && f.isFile && f.executable));
    if (hit) setArgs([hit, ...args.slice(1)]);
    setResolveNote(hit ? `Resolved to ${hit}` : `"${exe}" was not found in ${SEARCH_DIRS.join(", ")}`);
  };

  const issue = issueFor("ProgramArguments") ?? issueFor("Program");

  return (
    <div>
      <FieldRow label="Run" help={RUN_KINDS.find((k) => k.kind === kind)!.hint} issue={issue}>
        <div role="radiogroup" aria-label="Run kind" className="inline-flex rounded-lg bg-white/[0.04] p-0.5 mb-2">
          {RUN_KINDS.map((k) => (
            <button
              key={k.kind}
              type="button"
              role="radio"
              aria-checked={kind === k.kind}
              disabled={disabled}
              onClick={() => switchKind(k.kind)}
              className={cn(
                "px-3 py-1 rounded-md text-xs transition-colors",
                kind === k.kind ? "bg-cyan-500/20 text-cyan-300" : "text-gray-500 hover:text-gray-300"
              )}
            >
              {k.title}
            </button>
          ))}
        </div>

        {kind === "command" && (
          <div className="flex gap-2">
            <select
              aria-label="Shell"
              value={args[0] ?? "/bin/sh"}
              disabled={disabled}
              onChange={(e) => setArgs([e.target.value, "-c", args[2] ?? ""])}
              className={cn(inputClass, "w-32 font-mono text-xs")}
            >
              {SHELLS.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
            <textarea
              aria-label="Command"
              rows={2}
              spellCheck={false}
              value={args[2] ?? ""}
              disabled={disabled}
              placeholder='e.g. /usr/bin/rsync -a "$HOME/Documents" /Volumes/Backup'
              onChange={(e) => setArgs([args[0] ?? "/bin/sh", "-c", e.target.value])}
              className={cn(inputClass, "font-mono text-xs resize-y")}
            />
          </div>
        )}

        {kind === "program" && (
          <div className="space-y-2">
            {typeof job.Program === "string" && (
              <input
                type="text"
                aria-label="Program"
                spellCheck={false}
                value={job.Program}
                disabled={disabled}
                onChange={(e) => onChange(setKey(job, "Program", e.target.value || undefined))}
                className={cn(inputClass, "font-mono text-xs")}
              />
            )}
            <StringList
              values={args}
              disabled={disabled}
              addLabel="Add argument"
              placeholder={args.length === 0 ? "/path/to/executable" : "argument"}
              onChange={(next) => onChange(setKey(job, "ProgramArguments", next))}
            />
            {args[0] && !args[0].includes("/") && (
              <button
                type="button"
                disabled={disabled}
                onClick={resolveExecutable}
                className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs text-cyan-400 hover:bg-cyan-500/10"
              >
                <Wand2 className="w-3.5 h-3.5" />
                Find the full path of "{args[0]}"
              </button>
            )}
            {resolveNote && <p className="text-[11px] text-gray-500">{resolveNote}</p>}
          </div>
        )}

        {kind === "script" && (
          <div className="flex gap-2">
            <select
              aria-label="Interpreter"
              value={args[0] ?? "/bin/sh"}
              disabled={disabled}
              onChange={(e) => setArgs([e.target.value, args[1] ?? ""])}
              className={cn(inputClass, "w-44 font-mono text-xs")}
            >
              {INTERPRETERS.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
            <input
              type="text"
              aria-label="Script path"
              spellCheck={false}
              value={args[1] ?? ""}
              disabled={disabled}
              placeholder="/Users/you/bin/backup.sh"
              onChange={(e) => setArgs([args[0] ?? "/bin/sh", e.target.value])}
              className={cn(inputClass, "font-mono text-xs")}
            />
          </div>
        )}

        {kind === "app" && (
          <input
            type="text"
            aria-label="Application"
            spellCheck={false}
            value={args[2] ?? ""}
            disabled={disabled}
            placeholder="Safari  or  /Applications/Safari.app"
            onChange={(e) => setArgs(["/usr/bin/open", "-a", e.target.value, ...args.slice(3)])}
            className={cn(inputClass, "font-mono text-xs")}
          />
        )}

        {kind === "shortcut" && (
          <>
            <datalist id={shortcutListId}>
              {shortcuts.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
            <input
              type="text"
              aria-label="Shortcut name"
              list={shortcutListId}
              value={args[2] ?? ""}
              disabled={disabled}
              placeholder={shortcuts.length > 0 ? "Pick or type a shortcut name" : "Shortcut name"}
              onChange={(e) => setArgs(["/usr/bin/shortcuts", "run", e.target.value])}
              className={inputClass}
            />
          </>
        )}
      </FieldRow>
    </div>
  );
}

// ── Sections ─────────────────────────────────────────────────────────

const GROUPS: { group: KeyGroup; title: string; open: boolean }[] = [
  { group: "triggers", title: "When", open: true },
  { group: "io", title: "Output and input", open: false },
  { group: "environment", title: "Environment", open: false },
  { group: "identity", title: "User and session", open: false },
  { group: "resources", title: "Resources and limits", open: false },
  { group: "advanced", title: "Advanced", open: false },
];

// Keys with their own controls above the generic sections.
const HANDLED = new Set(["Label", "Disabled", "Program", "ProgramArguments"]);

function Section({
  title,
  count,
  defaultOpen,
  children,
}: {
  title: string;
  count: number;
  defaultOpen: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen || count > 0);
  return (
    <section className="border-t border-white/[0.06]">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 py-2.5 text-left text-sm font-semibold text-gray-300 hover:text-white"
      >
        {open ? <ChevronDown className="w-4 h-4 text-gray-500" /> : <ChevronRight className="w-4 h-4 text-gray-500" />}
        {title}
        {count > 0 && (
          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-cyan-500/15 text-cyan-400" title="Keys set in this section">
            {count} set
          </span>
        )}
      </button>
      {open && <div className="pb-3 divide-y divide-white/[0.03]">{children}</div>}
    </section>
  );
}

export function JobForm({
  job,
  onChange,
  category,
  issues,
  disabled,
}: {
  job: PlistDict;
  onChange: (next: PlistDict) => void;
  category: JobCategory;
  issues: JobIssue[];
  disabled?: boolean;
}) {
  const isDaemon = scopeFor(category)?.kind === "daemon";
  const issueFor = useMemo(() => {
    const byKey = new Map<string, JobIssue>();
    for (const issue of issues) if (issue.key && !byKey.has(issue.key)) byKey.set(issue.key, issue);
    return (key: string) => byKey.get(key) ?? null;
  }, [issues]);

  const unknownKeys = Object.keys(job).filter((k) => !KEY_SPEC.has(k));
  const env = job.EnvironmentVariables;
  const hasPath = typeof env === "object" && env !== null && !Array.isArray(env) && "PATH" in env;

  const visible = (spec: KeySpec) =>
    !HANDLED.has(spec.key) && (spec.key in job || (!spec.deprecated && (!spec.daemonOnly || isDaemon)));

  return (
    <div>
      <RunSection job={job} onChange={onChange} disabled={disabled} issueFor={issueFor} />

      <FieldRow
        label="Disabled key"
        help="Writes Disabled=true into the plist. Prefer the Enable/Disable action: it uses launchd's own override database."
      >
        <Toggle
          label="Disabled key"
          checked={job.Disabled === true}
          disabled={disabled}
          onChange={(on) => onChange(setKey(job, "Disabled", on ? true : undefined))}
        />
      </FieldRow>

      {GROUPS.map(({ group, title, open }) => {
        const specs = LAUNCHD_KEYS.filter((s) => s.group === group && visible(s));
        if (specs.length === 0) return null;
        const count = specs.filter((s) => s.key in job).length;
        return (
          <Section key={group} title={title} count={count} defaultOpen={open}>
            {specs.map((spec) => (
              <FieldRow
                key={spec.key}
                label={spec.title}
                help={`${spec.key}${spec.deprecated ? " (deprecated)" : ""}: ${spec.help}`}
                issue={issueFor(spec.key)}
              >
                <SchemaField
                  spec={spec}
                  value={job[spec.key]}
                  disabled={disabled}
                  onChange={(v) => onChange(setKey(job, spec.key, v))}
                />
                {spec.key === "EnvironmentVariables" && !hasPath && !disabled && (
                  <button
                    type="button"
                    onClick={() =>
                      onChange(setKey(job, "EnvironmentVariables", { ...(typeof env === "object" && env && !Array.isArray(env) ? (env as PlistDict) : {}), PATH: DEFAULT_PATH }))
                    }
                    className="text-[11px] text-cyan-400 hover:underline"
                  >
                    Add a PATH with Homebrew and /usr/local (launchd's default is /usr/bin:/bin:/usr/sbin:/sbin)
                  </button>
                )}
              </FieldRow>
            ))}
          </Section>
        );
      })}

      {unknownKeys.length > 0 && (
        <Section title="Other keys" count={unknownKeys.length} defaultOpen={false}>
          {unknownKeys.map((key) => (
            <FieldRow key={key} label={key} issue={issueFor(key)}>
              <ComplexValue value={job[key]} disabled={disabled} onRemove={() => onChange(setKey(job, key, undefined))} />
            </FieldRow>
          ))}
        </Section>
      )}

      <p className="pt-3 text-[11px] text-gray-600">
        Every field shows its launchd key. Full reference: run <span className="font-mono">man launchd.plist</span> in Terminal.
      </p>
    </div>
  );
}
