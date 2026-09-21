import { useEffect, useId, useMemo, useRef, useState } from "react";
import { AppWindow, ChevronDown, ChevronRight, Loader2, Plus, Wand2 } from "lucide-react";
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
import { isPlistDict, type PlistDict, type PlistValue } from "@shared/plist";
import { t, useT, type TKey } from "@/i18n";
import { keyHelp, keyTitle } from "@/i18n/launchd";
import { FieldRow, SchemaField, StringList, Toggle, inputClass } from "./fields";
import { ChoosePathButton } from "./PathPicker";
import { PLIST_TYPES, PLIST_TYPE_LABELS, PlistTreeEditor, defaultForType, type PlistType } from "./PlistTreeEditor";
import { appNameProblem, buildOpenArgs, defaultAppName, parseOpenArgs } from "./scriptApp";

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
/** Used when the backend cannot tell the default PATH of this Mac. */
export const DEFAULT_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

// ── PATH ─────────────────────────────────────────────────────────────

/** A PATH the job can use: absolute folders, separated by colons. */
export function isUsablePath(path: unknown): path is string {
  return typeof path === "string" && path.length > 0 && path.length <= 4096 && !/[\0\n\r]/.test(path) && path.split(":").every((dir) => dir.startsWith("/"));
}

/** The default PATH of this Mac, from the backend. Never fails: the built-in PATH is the fallback. */
export async function fetchDefaultPath(): Promise<string> {
  try {
    const path = await backend.getDefaultPath();
    return isUsablePath(path) ? path : DEFAULT_PATH;
  } catch {
    return DEFAULT_PATH;
  }
}

/** True when PATH can be added: no PATH yet, and EnvironmentVariables is missing or a dictionary. */
export function needsAutoPath(job: PlistDict): boolean {
  const env = job.EnvironmentVariables;
  if (env === undefined) return true;
  return isPlistDict(env) && !("PATH" in env);
}

/** The job with EnvironmentVariables.PATH. A job that has a PATH, or a broken EnvironmentVariables, is returned as it is. */
export function withAutoPath(job: PlistDict, path: string): PlistDict {
  if (!needsAutoPath(job)) return job;
  return { ...job, EnvironmentVariables: { ...(isPlistDict(job.EnvironmentVariables) ? job.EnvironmentVariables : {}), PATH: path } };
}

export const AUTO_PATH_STORAGE_KEY = "macdash.autoPath";

/** Per-browser setting, on by default. */
export function readAutoPath(storage: Pick<Storage, "getItem"> | null): boolean {
  try {
    return storage?.getItem(AUTO_PATH_STORAGE_KEY) !== "0";
  } catch {
    return true;
  }
}

export function writeAutoPath(storage: Pick<Storage, "setItem"> | null, on: boolean): void {
  try {
    storage?.setItem(AUTO_PATH_STORAGE_KEY, on ? "1" : "0");
  } catch {
    // The choice lasts for this editor only.
  }
}

// ── Add key ──────────────────────────────────────────────────────────

/** First value of a key that the user adds by name. The widget of the key must be able to show it. */
export function initialValueForSpec(spec: KeySpec): PlistValue {
  switch (spec.type) {
    case "string":
      return spec.options?.[0] ?? "";
    case "integer": {
      const zeroFits = (spec.min === undefined || spec.min <= 0) && (spec.max === undefined || spec.max >= 0);
      return zeroFits ? 0 : spec.min ?? spec.max ?? 0;
    }
    case "boolean":
      return true;
    case "string-array":
      return [""];
    case "string-dict":
    case "bool-dict":
    case "integer-dict":
    case "complex":
      return {};
    case "keepalive":
      return true;
    case "calendar":
      return [{ Hour: 9, Minute: 0 }];
    case "session-type":
      return spec.options?.[0] ?? "Aqua";
  }
}

export function newKeyProblem(name: string, job: PlistDict): string | null {
  if (name === "") return t("editor.addKey.emptyName");
  if (name !== name.trim()) return t("editor.addKey.trimName");
  if (name in job) return t("editor.addKey.alreadyHasKey", { name });
  return null;
}

const RUN_KINDS: { kind: RunKind; titleKey: TKey; hintKey: TKey }[] = [
  { kind: "command", titleKey: "editor.run.kind.command.title", hintKey: "editor.run.kind.command.hint" },
  { kind: "program", titleKey: "editor.run.kind.program.title", hintKey: "editor.run.kind.program.hint" },
  { kind: "script", titleKey: "editor.run.kind.script.title", hintKey: "editor.run.kind.script.hint" },
  { kind: "app", titleKey: "editor.run.kind.app.title", hintKey: "editor.run.kind.app.hint" },
  { kind: "shortcut", titleKey: "editor.run.kind.shortcut.title", hintKey: "editor.run.kind.shortcut.hint" },
];

function argsOf(job: PlistDict): string[] {
  return Array.isArray(job.ProgramArguments) ? job.ProgramArguments.map((a) => (typeof a === "string" ? a : "")) : [];
}

function detectRunKind(job: PlistDict): RunKind {
  const a = argsOf(job);
  if (typeof job.Program === "string") return "program";
  if (a.length === 3 && SHELLS.includes(a[0]) && a[1] === "-c") return "command";
  if (parseOpenArgs(a)) return "app";
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
  const { t } = useT();
  const [kind, setKind] = useState<RunKind>(() => detectRunKind(job));
  const [shortcuts, setShortcuts] = useState<string[]>([]);
  const [resolveNote, setResolveNote] = useState<string | null>(null);
  const [builtApp, setBuiltApp] = useState<string | null>(null);
  const shortcutListId = useId();
  const args = argsOf(job);
  const openArgs = parseOpenArgs(args) ?? { app: "", wait: false, rest: [] };

  // The kind is sticky while the user types here: ["/bin/sh", ""] is a script in the making, not a program.
  // A change of the command from outside (undo, a dropped file, Expert mode) picks the kind again.
  const runSignature = (j: PlistDict) => JSON.stringify([j.Program ?? null, j.ProgramArguments ?? null]);
  const signature = runSignature(job);
  const ownSignature = useRef(signature);
  const [seenSignature, setSeenSignature] = useState(signature);
  if (seenSignature !== signature) {
    setSeenSignature(signature);
    if (ownSignature.current !== signature) {
      ownSignature.current = signature;
      setKind(detectRunKind(job));
      setResolveNote(null);
      setBuiltApp(null);
    }
  }
  /** Every change this section makes goes through here. */
  const commit = (next: PlistDict) => {
    ownSignature.current = runSignature(next);
    onChange(next);
  };
  const setArgs = (next: string[]) => commit(setKey(setKey(job, "Program", undefined), "ProgramArguments", next));

  useEffect(() => {
    if (kind === "shortcut" && shortcuts.length === 0) backend.listShortcuts().then(setShortcuts).catch(() => {});
  }, [kind, shortcuts.length]);

  const switchKind = (next: RunKind) => {
    setKind(next);
    setResolveNote(null);
    setBuiltApp(null);
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
    setResolveNote(hit ? t("editor.run.resolvedTo", { path: hit }) : t("editor.run.notFoundIn", { name: exe, dirs: SEARCH_DIRS.join(", ") }));
  };

  const issue = issueFor("ProgramArguments") ?? issueFor("Program");

  return (
    <div>
      <FieldRow jobKey="ProgramArguments" label={t("editor.run.label")} help={t(RUN_KINDS.find((k) => k.kind === kind)!.hintKey)} issue={issue}>
        <div role="radiogroup" aria-label={t("editor.run.kindGroupAria")} className="inline-flex rounded-lg bg-white/[0.04] p-0.5 mb-2">
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
              {t(k.titleKey)}
            </button>
          ))}
        </div>

        {kind === "command" && (
          <div className="flex gap-2">
            <select
              aria-label={t("editor.run.shellAria")}
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
              aria-label={t("editor.run.kind.command.title")}
              rows={2}
              spellCheck={false}
              value={args[2] ?? ""}
              disabled={disabled}
              placeholder={t("editor.run.commandPlaceholder")}
              onChange={(e) => setArgs([args[0] ?? "/bin/sh", "-c", e.target.value])}
              className={cn(inputClass, "font-mono text-xs resize-y")}
            />
          </div>
        )}

        {kind === "program" && (
          <div className="space-y-2">
            {typeof job.Program === "string" && (
              <div className="flex gap-1.5">
                <input
                  type="text"
                  aria-label={t("editor.field.program")}
                  spellCheck={false}
                  value={job.Program}
                  disabled={disabled}
                  onChange={(e) => commit(setKey(job, "Program", e.target.value || undefined))}
                  className={cn(inputClass, "font-mono text-xs")}
                />
                <ChoosePathButton
                  mode="executable"
                  value={job.Program}
                  disabled={disabled}
                  fieldLabel={t("editor.field.program")}
                  onPick={(path) => commit(setKey(job, "Program", path))}
                />
              </div>
            )}
            <StringList
              values={args}
              disabled={disabled}
              addLabel={t("editor.run.addArgument")}
              placeholder={args.length === 0 ? "/path/to/executable" : t("editor.run.argumentPlaceholder")}
              onChange={(next) => commit(setKey(job, "ProgramArguments", next))}
              choose={(i) => (i === 0 ? "executable" : null)}
              chooseLabel={t("editor.run.programArgumentChoose")}
            />
            {args.length === 0 && typeof job.Program !== "string" && (
              <ChoosePathButton mode="executable" disabled={disabled} fieldLabel={t("editor.field.program")} onPick={(path) => commit(setKey(job, "ProgramArguments", [path]))} />
            )}
            {args[0] && !args[0].includes("/") && (
              <button
                type="button"
                disabled={disabled}
                onClick={resolveExecutable}
                className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs text-cyan-400 hover:bg-cyan-500/10"
              >
                <Wand2 className="w-3.5 h-3.5" />
                {t("editor.run.findFullPath", { name: args[0] })}
              </button>
            )}
            {resolveNote && <p className="text-[11px] text-gray-500">{resolveNote}</p>}
          </div>
        )}

        {kind === "script" && (
          <div className="flex gap-2">
            <select
              aria-label={t("editor.run.interpreterAria")}
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
              aria-label={t("editor.field.scriptPath")}
              spellCheck={false}
              value={args[1] ?? ""}
              disabled={disabled}
              placeholder={t("editor.field.scriptPathPlaceholder")}
              onChange={(e) => setArgs([args[0] ?? "/bin/sh", e.target.value])}
              className={cn(inputClass, "font-mono text-xs")}
            />
            <ChoosePathButton mode="file" value={args[1]} disabled={disabled} fieldLabel={t("editor.field.scriptPath")} onPick={(path) => setArgs([args[0] ?? "/bin/sh", path])} />
          </div>
        )}
        {kind === "script" && (args[1] ?? "").startsWith("/") && !disabled && (
          <WrapInApp
            key={args[1]}
            scriptPath={args[1]}
            onBuilt={(appPath) => {
              // -W keeps open(1) alive until the app quits, so launchd sees the real run time and exit.
              setArgs(buildOpenArgs({ app: appPath, wait: true, rest: [] }));
              setKind("app");
              setBuiltApp(appPath);
            }}
          />
        )}

        {kind === "app" && (
          <div className="space-y-1.5">
            <div className="flex gap-1.5">
              <input
                type="text"
                aria-label={t("editor.field.application")}
                spellCheck={false}
                value={openArgs.app}
                disabled={disabled}
                placeholder={t("editor.run.appPlaceholder")}
                onChange={(e) => {
                  setBuiltApp(null);
                  setArgs(buildOpenArgs({ ...openArgs, app: e.target.value }));
                }}
                className={cn(inputClass, "font-mono text-xs")}
              />
              <ChoosePathButton
                mode="app"
                value={openArgs.app}
                disabled={disabled}
                fieldLabel={t("editor.field.application")}
                onPick={(path) => {
                  setBuiltApp(null);
                  setArgs(buildOpenArgs({ ...openArgs, app: path }));
                }}
              />
            </div>
            <label className="flex items-center gap-2 text-xs text-gray-400">
              <input
                type="checkbox"
                checked={openArgs.wait}
                disabled={disabled}
                onChange={(e) => setArgs(buildOpenArgs({ ...openArgs, wait: e.target.checked }))}
                className="h-3.5 w-3.5 rounded accent-cyan-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/50"
              />
              {(() => {
                const [before, after] = t("editor.run.waitForQuit").split("{flag}");
                return (
                  <>
                    {before}
                    <span className="font-mono">-W</span>
                    {after}
                  </>
                );
              })()}
            </label>
            {builtApp && (
              <p role="status" className="text-[11px] text-cyan-400/80">
                {(() => {
                  const [before, after] = t("editor.run.builtApp").split("{path}");
                  return (
                    <>
                      {before}
                      <span className="font-mono">{builtApp}</span>
                      {after}
                    </>
                  );
                })()}
              </p>
            )}
          </div>
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
              aria-label={t("editor.field.shortcutName")}
              list={shortcutListId}
              value={args[2] ?? ""}
              disabled={disabled}
              placeholder={shortcuts.length > 0 ? t("editor.run.pickShortcut") : t("editor.field.shortcutName")}
              onChange={(e) => setArgs(["/usr/bin/shortcuts", "run", e.target.value])}
              className={inputClass}
            />
          </>
        )}
      </FieldRow>
    </div>
  );
}

/** Lingon's "Build an App": the backend wraps the script in ~/Applications/<name>.app. */
function WrapInApp({ scriptPath, onBuilt }: { scriptPath: string; onBuilt: (appPath: string) => void }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(() => defaultAppName(scriptPath));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameId = useId();
  const errorId = useId();
  const problem = appNameProblem(name);

  const build = async () => {
    if (problem || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await backend.buildScriptApp(scriptPath, name);
      if (!result || typeof result.path !== "string" || !result.path.startsWith("/")) throw new Error(t("editor.wrapApp.noPathReturned"));
      onBuilt(result.path);
    } catch (e) {
      setError((e as Error).message || t("editor.wrapApp.buildFailed"));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        aria-expanded={false}
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs text-cyan-400 hover:bg-cyan-500/10"
      >
        <AppWindow className="w-3.5 h-3.5" aria-hidden />
        {t("editor.wrapApp.button")}
      </button>
    );
  }

  const [descBefore, descRest] = t("editor.wrapApp.description").split("{path}");
  const [descMiddle, descAfter] = descRest.split("{shebang}");

  return (
    <div className="rounded-lg border border-white/[0.06] bg-black/20 p-3 space-y-2">
      <p className="text-[11px] leading-snug text-gray-500">
        {descBefore}
        <span className="font-mono">~/Applications/{name || "<name>"}.app</span>
        {descMiddle}
        <span className="font-mono">#!</span>
        {descAfter}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={nameId} className="text-xs text-gray-400">
          {t("editor.wrapApp.nameLabel")}
        </label>
        <input
          id={nameId}
          type="text"
          autoFocus
          spellCheck={false}
          value={name}
          disabled={busy}
          aria-invalid={problem !== null}
          aria-describedby={errorId}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              build();
            } else if (e.key === "Escape") {
              // Consume Escape so the editor dialog stays open.
              e.preventDefault();
              setOpen(false);
            }
          }}
          className={cn(inputClass, "w-56")}
        />
        <button
          type="button"
          disabled={busy || problem !== null}
          onClick={build}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-cyan-950 bg-cyan-400 hover:bg-cyan-300 disabled:opacity-40"
        >
          {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden />}
          {t("editor.wrapApp.buildButton")}
        </button>
        <button type="button" disabled={busy} onClick={() => setOpen(false)} className="px-2 py-1.5 rounded-lg text-xs text-gray-400 hover:bg-white/[0.06]">
          {t("common.cancel")}
        </button>
      </div>
      <p id={errorId} role="alert" className={cn("text-[11px] leading-snug", error ? "text-red-400" : "text-amber-400")}>
        {error ?? (name !== "" ? problem : null)}
      </p>
    </div>
  );
}

// ── Sections ─────────────────────────────────────────────────────────

const GROUPS: { group: KeyGroup; titleKey: TKey; open: boolean }[] = [
  { group: "triggers", titleKey: "editor.group.triggers", open: true },
  { group: "io", titleKey: "editor.group.io", open: false },
  { group: "environment", titleKey: "editor.group.environment", open: false },
  { group: "identity", titleKey: "editor.group.identity", open: false },
  { group: "resources", titleKey: "editor.group.resources", open: false },
  { group: "advanced", titleKey: "editor.group.advanced", open: false },
];

// Keys with their own controls above the generic sections.
const HANDLED = new Set(["Label", "Disabled", "Program", "ProgramArguments"]);

function Section({
  title,
  count,
  defaultOpen,
  reveal = 0,
  children,
}: {
  title: string;
  count: number;
  defaultOpen: boolean;
  /** A new number opens the section: "Add key" put a key in here. */
  reveal?: number;
  children: React.ReactNode;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(defaultOpen || count > 0);
  const [revealed, setRevealed] = useState(reveal);
  if (revealed !== reveal) {
    setRevealed(reveal);
    setOpen(true);
  }
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
          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-cyan-500/15 text-cyan-400" title={t("editor.section.countBadgeTitle")}>
            {t("editor.section.countBadge", { count })}
          </span>
        )}
      </button>
      {open && <div className="pb-3 divide-y divide-white/[0.03]">{children}</div>}
    </section>
  );
}

/** "Add key…": any key by name. A documented key gets its own widget, another key gets the tree editor. */
function AddKey({ job, onAdd }: { job: PlistDict; onAdd: (name: string, type: PlistType) => void }) {
  const { t } = useT();
  const [name, setName] = useState("");
  const [type, setType] = useState<PlistType>("string");
  const listId = useId();
  const nameId = useId();
  const errorId = useId();
  const spec = KEY_SPEC.get(name);
  const problem = newKeyProblem(name, job);
  const unused = useMemo(() => LAUNCHD_KEYS.filter((s) => !(s.key in job) && s.key !== "Label"), [job]);

  const add = () => {
    if (problem) return;
    onAdd(name, type);
    setName("");
  };

  return (
    <section aria-label={t("editor.addKey.label")} className="border-t border-white/[0.06] py-3 space-y-1.5">
      <datalist id={listId}>
        {unused.map((s) => (
          <option key={s.key} value={s.key}>
            {keyTitle(s)}
          </option>
        ))}
      </datalist>
      <div className="flex flex-wrap items-center gap-1.5">
        <label htmlFor={nameId} className="text-sm font-semibold text-gray-300 pr-1">
          {t("editor.addKey.label")}
        </label>
        <input
          id={nameId}
          type="text"
          list={listId}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          value={name}
          placeholder={t("editor.addKey.placeholder")}
          aria-invalid={name !== "" && problem !== null}
          aria-describedby={errorId}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            add();
          }}
          className={cn(inputClass, "w-64 font-mono text-xs")}
        />
        <select
          aria-label={t("editor.addKey.typeAria")}
          value={spec ? "" : type}
          disabled={spec !== undefined}
          title={spec ? t("editor.addKey.typeFixedTitle") : undefined}
          onChange={(e) => setType(e.target.value as PlistType)}
          className={cn(inputClass, "w-32 text-xs")}
        >
          {spec && <option value="">{spec.type}</option>}
          {PLIST_TYPES.map((pt) => (
            <option key={pt} value={pt}>
              {PLIST_TYPE_LABELS[pt]}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={problem !== null}
          onClick={add}
          className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs text-gray-300 bg-white/[0.06] hover:bg-white/[0.1] disabled:opacity-40"
        >
          <Plus className="w-3.5 h-3.5" aria-hidden />
          {t("common.add")}
        </button>
      </div>
      <p id={errorId} className={cn("text-[11px] leading-snug", name !== "" && problem ? "text-amber-400" : "text-gray-600")}>
        {name !== "" && problem
          ? problem
          : spec
            ? `${keyTitle(spec)}: ${keyHelp(spec)}`
            : name !== ""
              ? t("editor.addKey.undocumented")
              : t("editor.addKey.hint")}
      </p>
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
  const { t } = useT();
  const isDaemon = scopeFor(category)?.kind === "daemon";
  const issueFor = useMemo(() => {
    const byKey = new Map<string, JobIssue>();
    for (const issue of issues) if (issue.key && !byKey.has(issue.key)) byKey.set(issue.key, issue);
    return (key: string) => byKey.get(key) ?? null;
  }, [issues]);

  const unknownKeys = Object.keys(job).filter((k) => !KEY_SPEC.has(k));
  const jobLabel = typeof job.Label === "string" ? job.Label : undefined;

  const visible = (spec: KeySpec) =>
    !HANDLED.has(spec.key) && (spec.key in job || (!spec.deprecated && (!spec.daemonOnly || isDaemon)));

  // "Add key" and the PATH button change the job from outside a field: open the section and show the row.
  const root = useRef<HTMLDivElement>(null);
  const [reveal, setReveal] = useState<{ key: string; n: number } | null>(null);
  useEffect(() => {
    if (!reveal) return;
    const frame = requestAnimationFrame(() => {
      // Program has no row of its own: it is part of the Run row.
      const wanted = reveal.key === "Program" ? "ProgramArguments" : reveal.key;
      const row = [...(root.current?.querySelectorAll<HTMLElement>("[data-job-key]") ?? [])].find((el) => el.dataset.jobKey === wanted);
      if (!row) return;
      row.scrollIntoView({ block: "center", behavior: "smooth" });
      row.querySelector<HTMLElement>("input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])")?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [reveal]);
  const revealFor = (keys: string[]) => (reveal && keys.includes(reveal.key) ? reveal.n : 0);

  const addKey = (name: string, type: PlistType) => {
    const spec = KEY_SPEC.get(name);
    onChange(setKey(job, name, spec ? initialValueForSpec(spec) : defaultForType(type)));
    setReveal((r) => ({ key: name, n: (r?.n ?? 0) + 1 }));
  };

  const [pathBusy, setPathBusy] = useState(false);
  const latestJob = useRef(job);
  latestJob.current = job;
  const addPath = async () => {
    setPathBusy(true);
    const path = await fetchDefaultPath();
    setPathBusy(false);
    // The job can change while the backend answers.
    if (needsAutoPath(latestJob.current)) onChange(withAutoPath(latestJob.current, path));
  };

  return (
    <div ref={root}>
      <RunSection job={job} onChange={onChange} disabled={disabled} issueFor={issueFor} />

      <FieldRow jobKey="Disabled" label={t("editor.field.disabledKey")} help={t("editor.field.disabledKeyHelp")}>
        <Toggle
          label={t("editor.field.disabledKey")}
          checked={job.Disabled === true}
          disabled={disabled}
          onChange={(on) => onChange(setKey(job, "Disabled", on ? true : undefined))}
        />
      </FieldRow>

      {GROUPS.map(({ group, titleKey, open }) => {
        const specs = LAUNCHD_KEYS.filter((s) => s.group === group && visible(s));
        if (specs.length === 0) return null;
        const count = specs.filter((s) => s.key in job).length;
        return (
          <Section key={group} title={t(titleKey)} count={count} defaultOpen={open} reveal={revealFor(specs.map((s) => s.key))}>
            {specs.map((spec) => (
              <FieldRow
                key={spec.key}
                jobKey={spec.key}
                label={keyTitle(spec)}
                help={`${spec.key}${spec.deprecated ? ` (${t("editor.key.deprecated")})` : ""}: ${keyHelp(spec)}`}
                issue={issueFor(spec.key)}
              >
                <SchemaField
                  spec={spec}
                  value={job[spec.key]}
                  disabled={disabled}
                  jobLabel={jobLabel}
                  onChange={(v) => onChange(setKey(job, spec.key, v))}
                />
                {spec.key === "EnvironmentVariables" && needsAutoPath(job) && !disabled && (
                  <button type="button" disabled={pathBusy} onClick={addPath} className="text-left text-[11px] text-cyan-400 hover:underline disabled:opacity-50">
                    {t("editor.field.addDefaultPath")}
                  </button>
                )}
              </FieldRow>
            ))}
          </Section>
        );
      })}

      {unknownKeys.length > 0 && (
        <Section title={t("editor.section.otherKeys")} count={unknownKeys.length} defaultOpen={false} reveal={revealFor(unknownKeys)}>
          {unknownKeys.map((key) => (
            <FieldRow key={key} jobKey={key} label={key} issue={issueFor(key)}>
              <PlistTreeEditor name={key} value={job[key]} disabled={disabled} defaultType="string" onChange={(v) => onChange(setKey(job, key, v))} />
            </FieldRow>
          ))}
        </Section>
      )}

      {!disabled && <AddKey job={job} onAdd={addKey} />}

      <p className="pt-3 text-[11px] text-gray-600">
        {(() => {
          const [before, after] = t("editor.footer.manualRef").split("{command}");
          return (
            <>
              {before}
              <span className="font-mono">man launchd.plist</span>
              {after}
            </>
          );
        })()}
      </p>
    </div>
  );
}
