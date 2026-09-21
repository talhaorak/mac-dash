import { useId, useMemo, useRef, useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import { Dialog } from "@/components/ui/Dialog";
import { ConfirmButton } from "@/components/ui/ConfirmButton";
import { metaKey, type JobMeta } from "@/lib/backend";
import { useJobPlists, type ServiceInfo } from "@/stores/app";
import { cn } from "@/lib/utils";
import { LAUNCHD_KEYS, scopeFor } from "@shared/launchd";
import { inputClass } from "./fields";
import { InlineError } from "./StartupPanels";
import {
  MAX_KEY_LENGTH,
  RULE_FIELDS,
  defaultRule,
  fieldSpec,
  matchesFolder,
  newFolderId,
  operatorTakesValue,
  operatorTitle,
  operatorsFor,
  ruleNeedsPlist,
  ruleProblem,
  type RuleField,
  type RuleOperator,
  type SmartFolder,
  type SmartRule,
} from "./SmartFolders";

const PREVIEW_ROWS = 8;
const MAX_RULES = 20;

export interface SmartFolderEditorProps {
  open: boolean;
  /** The folder to edit. `null` starts a new folder. */
  folder: SmartFolder | null;
  /** All jobs, for the live preview. */
  services: ServiceInfo[];
  /** Notes and tags by `metaKey`, for the tag rules. */
  meta: Record<string, JobMeta>;
  /** Known tags, offered as suggestions for the tag field. */
  tags: string[];
  onSave: (folder: SmartFolder) => void;
  /** Shown only for a saved folder. The editor asks for a second click before it calls this. */
  onDelete?: (id: string) => void;
  onClose: () => void;
}

/** Dialog that edits one smart folder: name, match mode and rules, with a live preview. */
export function SmartFolderEditor({ open, folder, services, meta, tags, onSave, onDelete, onClose }: SmartFolderEditorProps) {
  const titleId = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  return (
    <Dialog open={open} onClose={onClose} labelledBy={titleId} initialFocusRef={nameRef} className="max-w-2xl!">
      {/* The dialog mounts its children on open, so every open starts from a fresh draft. */}
      <EditorBody titleId={titleId} nameRef={nameRef} folder={folder} services={services} meta={meta} tags={tags} onSave={onSave} onDelete={onDelete} onClose={onClose} />
    </Dialog>
  );
}

function EditorBody({
  titleId,
  nameRef,
  folder,
  services,
  meta,
  tags,
  onSave,
  onDelete,
  onClose,
}: Omit<SmartFolderEditorProps, "open"> & { titleId: string; nameRef: React.RefObject<HTMLInputElement | null> }) {
  const tagListId = useId();
  const keyListId = useId();
  const problemId = useId();
  // The first render fixes the mode. The parent clears `folder` while the close animation still runs.
  const [original] = useState(folder);
  const [name, setName] = useState(folder?.name ?? "");
  const [match, setMatch] = useState<"all" | "any">(folder?.match ?? "all");
  const [rules, setRules] = useState<SmartRule[]>(folder && folder.rules.length > 0 ? folder.rules : [defaultRule("label")]);
  const [submitted, setSubmitted] = useState(false);

  const problems = rules.map(ruleProblem);
  const nameProblem = name.trim() === "" ? "Enter a name." : null;
  const valid = nameProblem === null && rules.length > 0 && problems.every((p) => p === null);

  // The plists are large. They are read when the first launchd-key rule appears in the draft.
  const needsPlists = rules.some(ruleNeedsPlist);
  const jobPlists = useJobPlists(needsPlists);
  const plists = jobPlists.plists;
  const waitsForPlists = needsPlists && plists === null;

  const preview = useMemo(() => {
    const draft: SmartFolder = { id: "preview", name: "", match, rules: rules.filter((r) => ruleProblem(r) === null) };
    if (draft.rules.length === 0) return { count: 0, first: [] as ServiceInfo[] };
    const now = new Date();
    const hits = services.filter((s) => matchesFolder(s, meta[metaKey(s)], draft, now, plists ? (plists[metaKey(s)] ?? null) : undefined));
    return { count: hits.length, first: hits.slice(0, PREVIEW_ROWS) };
  }, [services, meta, match, rules, plists]);

  const setRule = (index: number, next: SmartRule) => setRules(rules.map((r, i) => (i === index ? next : r)));

  const save = () => {
    setSubmitted(true);
    if (!valid) return;
    const clean = (r: SmartRule): SmartRule =>
      ruleNeedsPlist(r) ? { ...r, key: r.key?.trim() ?? "", value: operatorTakesValue(r.operator) ? r.value.trim() : "" } : { field: r.field, operator: r.operator, value: r.value.trim() };
    onSave({ id: original?.id ?? newFolderId(), name: name.trim().slice(0, 60), match, rules: rules.map(clean) });
  };

  return (
    <form
      className="p-6 space-y-5"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id={titleId} className="text-lg font-bold text-white">
            {original ? "Edit smart folder" : "New smart folder"}
          </h2>
          <p className="text-xs text-gray-500 mt-1">A smart folder is a saved filter. It combines with the search box and the other filters.</p>
        </div>
        <button type="button" aria-label="Close" onClick={onClose} className="p-2 rounded-lg hover:bg-white/[0.06] text-gray-400 focus:outline-none focus-visible:ring-1 focus-visible:ring-cyan-500/50">
          <X className="w-4 h-4" aria-hidden />
        </button>
      </div>

      <label className="block space-y-1">
        <span className="text-xs font-medium text-gray-400">Name</span>
        <input
          ref={nameRef}
          type="text"
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          aria-invalid={submitted && nameProblem !== null}
          aria-describedby={submitted && nameProblem ? problemId : undefined}
          placeholder="Nightly backups"
          className={inputClass}
        />
        {submitted && nameProblem && (
          <span id={problemId} className="block text-[11px] text-red-400">
            {nameProblem}
          </span>
        )}
      </label>

      <fieldset className="space-y-2">
        <legend className="text-xs font-medium text-gray-400">Rules</legend>
        <div className="flex items-center gap-2 text-xs text-gray-400">
          <span id={`${titleId}-match`}>A job belongs to the folder when it matches</span>
          <select
            aria-labelledby={`${titleId}-match`}
            value={match}
            onChange={(e) => setMatch(e.target.value === "any" ? "any" : "all")}
            className={cn(inputClass, "w-auto! py-1 text-xs")}
          >
            <option value="all">all rules</option>
            <option value="any">any rule</option>
          </select>
        </div>

        <ul className="space-y-2">
          {rules.map((rule, i) => (
            <RuleRow
              key={i}
              index={i}
              rule={rule}
              problem={problems[i]}
              showProblem={submitted || rule.value !== "" || (rule.key ?? "") !== ""}
              tagListId={tagListId}
              keyListId={keyListId}
              canRemove={rules.length > 1}
              onChange={(next) => setRule(i, next)}
              onRemove={() => setRules(rules.filter((_, j) => j !== i))}
            />
          ))}
        </ul>
        <datalist id={tagListId}>
          {tags.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
        <datalist id={keyListId}>
          {LAUNCHD_KEYS.map((k) => (
            <option key={k.key} value={k.key}>
              {k.title}
            </option>
          ))}
        </datalist>

        <button
          type="button"
          disabled={rules.length >= MAX_RULES}
          onClick={() => setRules([...rules, defaultRule("label")])}
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs text-gray-300 bg-white/[0.06] hover:bg-white/[0.1] disabled:opacity-40 focus:outline-none focus-visible:ring-1 focus-visible:ring-cyan-500/50"
        >
          <Plus className="w-3 h-3" aria-hidden /> Add rule
        </button>
      </fieldset>

      <section aria-label="Preview" className="rounded-xl border border-white/[0.06] bg-black/20 p-3 space-y-1.5">
        <p className="text-xs text-gray-300" aria-live="polite">
          {waitsForPlists && !jobPlists.error ? "Reading the plists of the jobs…" : `${preview.count} of ${services.length} jobs match`}
        </p>
        {jobPlists.error && (
          <InlineError
            title={plists ? "The job plists could not be read again. The preview uses the last copy." : "The job plists could not be read. A launchd-key rule matches no job until they are."}
            message={jobPlists.error}
            onRetry={jobPlists.retry}
            retrying={jobPlists.loading}
          />
        )}
        {preview.first.length > 0 && (
          <ul className="space-y-0.5">
            {preview.first.map((s) => (
              <li key={metaKey(s)} className="flex items-baseline gap-2 text-[11px] min-w-0">
                <span className="font-mono text-gray-300 truncate">{s.label}</span>
                <span className="ml-auto flex-shrink-0 text-gray-600">{scopeFor(s.category)?.title}</span>
              </li>
            ))}
            {preview.count > preview.first.length && <li className="text-[11px] text-gray-600">and {preview.count - preview.first.length} more</li>}
          </ul>
        )}
      </section>

      <div className="flex items-center gap-2">
        {original && onDelete && (
          <ConfirmButton
            onConfirm={() => onDelete(original.id)}
            confirmLabel="Click again to delete"
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs text-gray-400 hover:text-red-400 hover:bg-red-500/10 focus:outline-none focus-visible:ring-1 focus-visible:ring-red-500/50"
            armedClassName="bg-red-500/20 text-red-300!"
          >
            <Trash2 className="w-3.5 h-3.5" aria-hidden /> Delete folder
          </ConfirmButton>
        )}
        <div className="flex-1" />
        <button type="button" onClick={onClose} className="px-3 py-2 rounded-xl text-xs text-gray-300 bg-white/[0.04] hover:bg-white/[0.08] focus:outline-none focus-visible:ring-1 focus-visible:ring-cyan-500/50">
          Cancel
        </button>
        <button
          type="submit"
          aria-disabled={!valid}
          className={cn(
            "px-3 py-2 rounded-xl text-xs font-semibold text-cyan-950 bg-cyan-400 hover:bg-cyan-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300",
            !valid && "opacity-50"
          )}
        >
          Save folder
        </button>
      </div>
    </form>
  );
}

function RuleRow({
  index,
  rule,
  problem,
  showProblem,
  tagListId,
  keyListId,
  canRemove,
  onChange,
  onRemove,
}: {
  index: number;
  rule: SmartRule;
  problem: string | null;
  showProblem: boolean;
  tagListId: string;
  keyListId: string;
  canRemove: boolean;
  onChange: (rule: SmartRule) => void;
  onRemove: () => void;
}) {
  const problemId = useId();
  const spec = fieldSpec(rule.field);
  const n = index + 1;
  const invalid = showProblem && problem !== null;
  const selectClass = cn(inputClass, "py-1.5 text-xs");
  const isPlistRule = spec.kind === "plist";
  const takesValue = operatorTakesValue(rule.operator);

  return (
    <li>
      <div
        className={cn(
          "grid gap-2 items-center",
          isPlistRule
            ? "grid-cols-[minmax(0,0.9fr)_minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_auto]"
            : "grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1.4fr)_auto]"
        )}
      >
        <select
          aria-label={`Rule ${n}: field`}
          value={rule.field}
          // A new field brings its own operators and values: start from its default rule.
          onChange={(e) => onChange(defaultRule(e.target.value as RuleField))}
          className={selectClass}
        >
          {RULE_FIELDS.map((f) => (
            <option key={f.field} value={f.field}>
              {f.title}
            </option>
          ))}
        </select>

        {isPlistRule && (
          <input
            aria-label={`Rule ${n}: launchd key`}
            type="text"
            list={keyListId}
            value={rule.key ?? ""}
            maxLength={MAX_KEY_LENGTH}
            spellCheck={false}
            onChange={(e) => onChange({ ...rule, key: e.target.value })}
            aria-invalid={invalid}
            aria-describedby={invalid ? problemId : undefined}
            placeholder="RunAtLoad"
            className={cn(inputClass, "py-1.5 text-xs font-mono")}
          />
        )}

        <select
          aria-label={`Rule ${n}: operator`}
          value={rule.operator}
          onChange={(e) => onChange({ ...rule, operator: e.target.value as RuleOperator })}
          className={selectClass}
        >
          {operatorsFor(rule.field).map((op) => (
            <option key={op} value={op}>
              {operatorTitle(rule.field, op)}
            </option>
          ))}
        </select>

        {!takesValue ? (
          // "exists" and "does not exist" look at the key only. The empty cell keeps the columns in line.
          <span aria-hidden />
        ) : spec.kind === "enum" || spec.kind === "boolean" ? (
          <select
            aria-label={`Rule ${n}: value`}
            value={rule.value}
            onChange={(e) => onChange({ ...rule, value: e.target.value })}
            aria-invalid={invalid}
            aria-describedby={invalid ? problemId : undefined}
            className={selectClass}
          >
            {(spec.kind === "boolean"
              ? [
                  { value: "true", title: "yes" },
                  { value: "false", title: "no" },
                ]
              : (spec.options ?? [])
            ).map((o) => (
              <option key={o.value} value={o.value}>
                {o.title}
              </option>
            ))}
          </select>
        ) : (
          <input
            aria-label={`Rule ${n}: value`}
            type={spec.kind === "number" ? "number" : "text"}
            step={spec.kind === "number" ? 1 : undefined}
            list={rule.field === "tag" ? tagListId : undefined}
            value={rule.value}
            onChange={(e) => onChange({ ...rule, value: e.target.value })}
            aria-invalid={invalid}
            aria-describedby={invalid ? problemId : undefined}
            placeholder={spec.kind === "number" ? "0" : rule.field === "label" ? "com.example." : isPlistRule ? "true" : ""}
            className={cn(inputClass, "py-1.5 text-xs font-mono")}
          />
        )}

        <button
          type="button"
          disabled={!canRemove}
          onClick={onRemove}
          aria-label={`Remove rule ${n}`}
          title="Remove rule"
          className="p-1.5 rounded-lg text-gray-500 hover:text-red-400 hover:bg-red-500/10 disabled:opacity-30 focus:outline-none focus-visible:ring-1 focus-visible:ring-cyan-500/50"
        >
          <X className="w-3.5 h-3.5" aria-hidden />
        </button>
      </div>
      {invalid && (
        <p id={problemId} className="mt-1 text-[11px] text-red-400">
          {problem}
        </p>
      )}
      {isPlistRule && (
        <p className="mt-1 text-[11px] text-gray-600">
          The key comes from the plist of the job. A dot reaches into a dictionary: KeepAlive.SuccessfulExit. The value is compared as text, a boolean is
          true or false, and a list matches when one element matches.
        </p>
      )}
    </li>
  );
}
