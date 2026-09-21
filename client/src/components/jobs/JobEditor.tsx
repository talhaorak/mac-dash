import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, History, Info, Loader2, X, XCircle } from "lucide-react";
import { Dialog } from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";
import { backend, type JobRef, type JobRevision } from "@/lib/backend";
import { useServicesStore } from "@/stores/app";
import { cn } from "@/lib/utils";
import {
  JOB_SCOPES,
  JOB_TEMPLATES,
  collectPaths,
  scopeFor,
  validateJob,
  type JobCategory,
  type JobIssue,
  type PathFacts,
} from "@shared/launchd";
import { PlistParseError, parsePlistDict, serializePlist, type PlistDict } from "@shared/plist";
import { JobForm, setKey } from "./JobForm";
import { XmlEditor } from "./XmlEditor";
import { DRAFT_DEBOUNCE_MS, browserStorage, clearDraft, jobDraftKey, readDraft, writeDraft, type JobDraft } from "./drafts";
import { inputClass } from "./fields";

export type JobEditorTarget =
  | { mode: "new"; templateId?: string; category?: JobCategory }
  | { mode: "edit"; job: JobRef }
  | { mode: "duplicate"; job: JobRef };

type Tab = "form" | "expert" | "revisions";

const WRITABLE_SCOPES = JOB_SCOPES.filter((s) => s.writable);

function uniqueLabel(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

export function JobEditor({ target, onClose }: { target: JobEditorTarget | null; onClose: () => void }) {
  return (
    <Dialog
      open={target !== null}
      onClose={onClose}
      closeOnBackdrop={false}
      ariaLabel="launchd job editor"
      className="max-w-5xl! h-[88vh] flex flex-col overflow-hidden p-0"
    >
      {target && <EditorBody key={JSON.stringify(target)} target={target} onClose={onClose} />}
    </Dialog>
  );
}

function EditorBody({ target, onClose }: { target: JobEditorTarget; onClose: () => void }) {
  const titleId = useId();
  const services = useServicesStore((s) => s.services);

  // A new job starts from its template right away, so the form mounts with the real values.
  const [fresh] = useState<PlistDict | null>(() => {
    if (target.mode !== "new") return null;
    const template = JOB_TEMPLATES.find((t) => t.id === target.templateId) ?? JOB_TEMPLATES[0];
    return template.build(uniqueLabel("com.example.my-job", new Set(services.map((s) => s.label))));
  });

  const [loading, setLoading] = useState(target.mode !== "new");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [category, setCategory] = useState<JobCategory>(target.mode === "new" ? target.category ?? "user-agents" : "user-agents");
  const [job, setJob] = useState<PlistDict>(fresh ?? {});
  const [xml, setXml] = useState(() => (fresh ? serializePlist(fresh) : ""));
  const [xmlError, setXmlError] = useState<PlistParseError | Error | null>(null);
  const [tab, setTab] = useState<Tab>("form");
  const [original, setOriginal] = useState<JobRef | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [readOnly, setReadOnly] = useState(false);
  const [pathFacts, setPathFacts] = useState<PathFacts[]>([]);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(target.mode === "new");
  /** The user changed something. A new job is dirty from the start, but there is nothing to keep as a draft yet. */
  const [edited, setEdited] = useState(false);
  const [revisions, setRevisions] = useState<JobRevision[] | null>(null);
  /** Expert edits keep the user's exact text (comments, order). Form edits regenerate it. */
  const xmlIsSource = useRef(false);

  // ── Draft ──────────────────────────────────────────────────────────
  // Unsaved work is kept in localStorage: it survives Escape, Cancel and a page reload.
  const [storage] = useState(browserStorage);
  const draftKey = jobDraftKey(target);
  /** A stored draft the user has not restored or discarded yet. It is never overwritten while it waits. */
  const [pendingDraft, setPendingDraft] = useState<JobDraft | null>(null);
  const draftState = useRef({ xml, category, enabled: false, closed: false });
  draftState.current = { ...draftState.current, xml, category, enabled: edited && !readOnly && pendingDraft === null };

  const offerDraft = (currentXml: string, currentCategory: JobCategory) => {
    const draft = readDraft(storage, draftKey);
    if (!draft) return;
    if (draft.xml === currentXml && draft.category === currentCategory) clearDraft(storage, draftKey);
    else setPendingDraft(draft);
  };

  /** Write the draft now. Returns true when the current state is in storage. */
  const flushDraft = useCallback((): boolean => {
    const { xml, category, enabled, closed } = draftState.current;
    if (!enabled || closed) return false;
    const stored = readDraft(storage, draftKey);
    if (stored && stored.xml === xml && stored.category === category) return true; // keep its time
    return writeDraft(storage, draftKey, { xml, category, savedAt: Date.now() });
  }, [storage, draftKey]);

  const dropDraft = () => {
    draftState.current.closed = true;
    clearDraft(storage, draftKey);
  };

  const draftEnabled = draftState.current.enabled;
  useEffect(() => {
    if (!draftEnabled) return;
    const timer = setTimeout(flushDraft, DRAFT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [xml, category, draftEnabled, flushDraft]);

  // Do not lose the last 800 ms when the page reloads or the dialog closes.
  useEffect(() => {
    window.addEventListener("pagehide", flushDraft);
    return () => {
      window.removeEventListener("pagehide", flushDraft);
      flushDraft();
    };
  }, [flushDraft]);

  // ── Load ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (target.mode === "new") return offerDraft(xml, category);
    let cancelled = false;
    const taken = new Set(services.map((s) => s.label));

    backend
      .readJob(target.job)
      .then((doc) => {
        if (cancelled) return;
        let parsed: PlistDict = {};
        let parseError: Error | null = null;
        try {
          parsed = parsePlistDict(doc.xml);
        } catch (e) {
          parseError = e as Error;
        }

        if (target.mode === "duplicate") {
          const copy = setKey(parsed, "Label", uniqueLabel(`${doc.label}.copy`, taken));
          setCategory(doc.writable ? doc.category : "user-agents");
          setJob(copy);
          setXml(serializePlist(copy));
          setDirty(true);
          offerDraft(serializePlist(copy), doc.writable ? doc.category : "user-agents");
        } else {
          setCategory(doc.category);
          setJob(parsed);
          setXml(doc.xml);
          setOriginal({ label: doc.label, category: doc.category });
          setFileName(doc.fileName);
          setReadOnly(!doc.writable);
          xmlIsSource.current = true;
          if (parseError) {
            setXmlError(parseError);
            setTab("expert");
          }
          if (doc.writable) offerDraft(doc.xml, doc.category);
        }
      })
      .catch((e: Error) => !cancelled && setLoadError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // The target is fixed for the lifetime of this component (keyed by the parent).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Edits ──────────────────────────────────────────────────────────
  const editForm = (next: PlistDict) => {
    setJob(next);
    setXml(serializePlist(next));
    setXmlError(null);
    xmlIsSource.current = false;
    setDirty(true);
    setEdited(true);
  };

  /** Returns false when the text is not a valid property list. */
  const editXml = (text: string): boolean => {
    setXml(text);
    xmlIsSource.current = true;
    setDirty(true);
    setEdited(true);
    try {
      setJob(parsePlistDict(text));
      setXmlError(null);
      return true;
    } catch (e) {
      setXmlError(e as Error);
      return false;
    }
  };

  const restoreDraft = () => {
    if (!pendingDraft) return;
    setCategory(pendingDraft.category);
    // A draft with an XML error can only be fixed in Expert mode.
    if (!editXml(pendingDraft.xml) || tab === "revisions") setTab("expert");
    setPendingDraft(null);
    toast.info("Draft restored. Save to apply it.");
  };

  const discardDraft = () => {
    clearDraft(storage, draftKey);
    setPendingDraft(null);
  };

  // ── Validation ─────────────────────────────────────────────────────
  const paths = useMemo(() => collectPaths(job).sort().join("\n"), [job]);
  useEffect(() => {
    if (!paths) return setPathFacts([]);
    const timer = setTimeout(() => {
      backend.checkPaths(paths.split("\n")).then(setPathFacts).catch(() => {});
    }, 400);
    return () => clearTimeout(timer);
  }, [paths]);

  const issues: JobIssue[] = useMemo(() => {
    const otherLabels = services
      .filter((s) => s.category === category && !(original && s.label === original.label && s.category === original.category))
      .map((s) => s.label);
    const label = typeof job.Label === "string" ? job.Label : "";
    return validateJob(job, {
      category,
      fileName: original && label === original.label ? fileName : null,
      otherLabels,
      pathFacts,
    });
  }, [job, category, original, fileName, services, pathFacts]);

  const counts = {
    error: issues.filter((i) => i.severity === "error").length,
    warning: issues.filter((i) => i.severity === "warning").length,
  };
  const blocked = xmlError !== null || issues.some((i) => i.blocking);
  const scope = scopeFor(category)!;

  // ── Save ───────────────────────────────────────────────────────────
  const save = async (load: boolean) => {
    if (blocked || saving || readOnly) return;
    setSaving(true);
    try {
      const result = await backend.saveJob({
        category,
        xml: xmlIsSource.current ? xml : serializePlist(job),
        original,
        load,
      });
      toast.success(load ? `Saved and loaded ${result.label}` : `Saved ${result.label} without loading`);
      dropDraft();
      onClose();
    } catch (e) {
      // "Saved, but launchd did not load the job" is a partial success: the file is written.
      const message = (e as Error).message;
      toast.error(message);
      if (message.startsWith("Saved, but")) {
        dropDraft();
        onClose();
      }
    } finally {
      setSaving(false);
    }
  };

  const openRevisions = () => {
    setTab("revisions");
    const label = original?.label ?? (typeof job.Label === "string" ? job.Label : "");
    backend.listJobRevisions(label).then(setRevisions).catch(() => setRevisions([]));
  };

  const restoreRevision = async (rev: JobRevision) => {
    try {
      editXml(await backend.readJobRevision(rev.id));
      setTab("expert");
      toast.info("Revision loaded into the editor. Save to apply it.");
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const requestClose = () => {
    if (!dirty || readOnly) return onClose();
    // Write the draft first, so the question tells the truth about what happens to the changes.
    const message = flushDraft()
      ? "Close the editor without saving?\n\nYour changes stay on this Mac as a draft. The editor offers to restore them the next time you open this job."
      : !edited
        ? "Close the editor? You did not change this job, so no draft is kept."
        : pendingDraft
          ? `Close the editor? These changes are lost.\n\nThe earlier draft from ${new Date(pendingDraft.savedAt).toLocaleString()} stays.`
          : "Discard the changes to this job?\n\nThey cannot be kept as a draft (over 200 KB, or the browser storage is not available).";
    if (window.confirm(message)) onClose();
  };

  const title =
    target.mode === "new" ? "New job" : target.mode === "duplicate" ? "Duplicate job" : readOnly ? "View job" : "Edit job";

  return (
    <>
      {/* Header */}
      <div className="flex items-start gap-4 px-6 pt-5 pb-4 border-b border-white/[0.06]">
        <div className="flex-1 min-w-0 space-y-3">
          <h2 id={titleId} className="text-lg font-bold text-white">
            {title}
          </h2>
          <div className="grid grid-cols-[1fr_220px] gap-3">
            <label className="space-y-1">
              <span className="text-[11px] font-medium text-gray-500">Label (name)</span>
              <input
                type="text"
                spellCheck={false}
                value={typeof job.Label === "string" ? job.Label : ""}
                disabled={readOnly || loading || tab === "expert"}
                onChange={(e) => editForm(setKey(job, "Label", e.target.value))}
                className={cn(inputClass, "font-mono")}
              />
            </label>
            <label className="space-y-1">
              <span className="text-[11px] font-medium text-gray-500">Runs for</span>
              <select
                value={category}
                disabled={readOnly || loading}
                onChange={(e) => {
                  setCategory(e.target.value as JobCategory);
                  setDirty(true);
                  setEdited(true);
                }}
                className={inputClass}
              >
                {(readOnly ? JOB_SCOPES : WRITABLE_SCOPES).map((s) => (
                  <option key={s.category} value={s.category}>
                    {s.category === "user-agents" ? "Me" : s.category === "global-agents" ? "All users" : s.category === "global-daemons" ? "root (daemon)" : s.title}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="text-[11px] text-gray-600">
            {scope.description} File: <span className="font-mono">{scope.dir}/{typeof job.Label === "string" && job.Label ? job.Label : "<label>"}.plist</span>
            {scope.needsAdmin && !readOnly ? ". Saving asks for an administrator password." : ""}
          </p>
        </div>
        <button type="button" aria-label="Close editor" onClick={requestClose} className="p-2 rounded-lg hover:bg-white/[0.06] text-gray-400">
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Tabs */}
      <div role="tablist" aria-label="Editor mode" className="flex gap-1 px-6 pt-3">
        {(
          [
            { id: "form", label: "Form" },
            { id: "expert", label: "Expert (XML)" },
            ...(target.mode === "edit" ? [{ id: "revisions", label: "Revisions" }] : []),
          ] as { id: Tab; label: string }[]
        ).map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            disabled={t.id === "form" && xmlError !== null}
            title={t.id === "form" && xmlError ? "Fix the XML error first" : undefined}
            onClick={() => (t.id === "revisions" ? openRevisions() : setTab(t.id))}
            className={cn(
              "px-3 py-1.5 rounded-lg text-xs font-medium transition-all disabled:opacity-40",
              tab === t.id ? "bg-cyan-500/15 text-cyan-400 ring-1 ring-cyan-500/30" : "text-gray-500 hover:text-gray-300 hover:bg-white/[0.04]"
            )}
          >
            {t.id === "revisions" && <History className="w-3 h-3 inline mr-1" />}
            {t.label}
          </button>
        ))}
      </div>

      {pendingDraft && (
        <div role="status" className="mx-6 mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-200/90">
          <History className="w-3.5 h-3.5 flex-shrink-0 text-amber-400" aria-hidden />
          <span>
            Unsaved draft from <time dateTime={new Date(pendingDraft.savedAt).toISOString()}>{new Date(pendingDraft.savedAt).toLocaleString()}</time>.{" "}
            <span className="text-amber-200/60">New edits are not kept as a draft until you restore or discard it.</span>
          </span>
          <span className="ml-auto flex gap-1">
            <button type="button" onClick={restoreDraft} className="px-2.5 py-1 rounded-lg font-medium text-cyan-950 bg-cyan-400 hover:bg-cyan-300">
              Restore
            </button>
            <button type="button" onClick={discardDraft} className="px-2.5 py-1 rounded-lg text-amber-200/90 hover:bg-white/[0.08]">
              Discard
            </button>
          </span>
        </div>
      )}

      {/* Body */}
      <div className="flex-1 min-h-0 grid grid-cols-[1fr_280px] gap-4 px-6 py-4">
        <div className="min-h-0 overflow-y-auto pr-2">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-gray-500 py-10 justify-center">
              <Loader2 className="w-4 h-4 animate-spin" /> Reading the job…
            </div>
          ) : loadError ? (
            <p role="alert" className="text-sm text-red-400 py-10 text-center">
              {loadError}
            </p>
          ) : tab === "form" ? (
            <JobForm job={job} onChange={editForm} category={category} issues={issues} disabled={readOnly} />
          ) : tab === "expert" ? (
            <div className="h-full flex flex-col gap-2">
              <XmlEditor value={xml} onChange={editXml} readOnly={readOnly} />
              {xmlError && (
                <p role="alert" className="text-xs text-red-400 font-mono">
                  {xmlError.message}
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-1">
              {revisions === null ? (
                <p className="text-sm text-gray-500">Loading…</p>
              ) : revisions.length === 0 ? (
                <p className="text-sm text-gray-500">No earlier versions. mac-dash keeps a copy every time it overwrites or deletes this job.</p>
              ) : (
                revisions.map((rev) => (
                  <div key={rev.id} className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-white/[0.03]">
                    <History className="w-3.5 h-3.5 text-gray-600" />
                    <span className="text-sm text-gray-300">{new Date(rev.at).toLocaleString()}</span>
                    <span className="text-xs text-gray-600 font-mono">{rev.size} B</span>
                    <button
                      type="button"
                      disabled={readOnly}
                      onClick={() => restoreRevision(rev)}
                      className="ml-auto px-2.5 py-1 rounded-lg text-xs text-cyan-400 hover:bg-cyan-500/10 disabled:opacity-40"
                    >
                      Load into editor
                    </button>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        {/* Checks */}
        <aside aria-label="Checks" className="min-h-0 overflow-y-auto rounded-xl bg-black/20 border border-white/[0.06] p-3 space-y-2">
          <h3 className="text-xs font-semibold text-gray-400 flex items-center gap-2">
            Checks
            {counts.error > 0 && <span className="text-red-400">{counts.error} errors</span>}
            {counts.warning > 0 && <span className="text-amber-400">{counts.warning} warnings</span>}
          </h3>
          {xmlError && <IssueLine issue={{ severity: "error", key: "XML", message: xmlError.message, blocking: true }} />}
          {!xmlError && issues.length === 0 && (
            <p className="flex items-center gap-1.5 text-xs text-green-400">
              <CheckCircle2 className="w-3.5 h-3.5" /> No problems found.
            </p>
          )}
          {!xmlError && issues.map((issue, i) => <IssueLine key={i} issue={issue} />)}
        </aside>
      </div>

      {/* Footer */}
      <div className="flex items-center gap-2 px-6 py-4 border-t border-white/[0.06]">
        {readOnly ? (
          <p className="text-xs text-gray-500">This job is part of macOS and is read-only. Duplicate it to make your own version.</p>
        ) : blocked ? (
          <p className="text-xs text-red-400">Fix the blocking errors to save.</p>
        ) : counts.error > 0 ? (
          <p className="text-xs text-amber-400">There are errors. You can still save.</p>
        ) : null}
        <div className="ml-auto flex gap-2">
          <button type="button" onClick={requestClose} className="px-3 py-2 rounded-xl text-sm text-gray-400 hover:bg-white/[0.06]">
            {readOnly ? "Close" : "Cancel"}
          </button>
          {!readOnly && (
            <>
              <button
                type="button"
                disabled={blocked || saving}
                onClick={() => save(false)}
                title="Write the file but do not load it into launchd"
                className="px-3 py-2 rounded-xl text-sm text-gray-300 bg-white/[0.06] hover:bg-white/[0.1] disabled:opacity-40"
              >
                Save only
              </button>
              <button
                type="button"
                disabled={blocked || saving}
                onClick={() => save(true)}
                className="px-4 py-2 rounded-xl text-sm font-medium text-cyan-950 bg-cyan-400 hover:bg-cyan-300 disabled:opacity-40 inline-flex items-center gap-2"
              >
                {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                Save and load
              </button>
            </>
          )}
        </div>
      </div>
    </>
  );
}

function IssueLine({ issue }: { issue: JobIssue }) {
  const Icon = issue.severity === "error" ? XCircle : issue.severity === "warning" ? AlertTriangle : Info;
  const tone = issue.severity === "error" ? "text-red-400" : issue.severity === "warning" ? "text-amber-400" : "text-gray-500";
  return (
    <div className="flex gap-2 text-[11px] leading-snug">
      <Icon className={cn("w-3.5 h-3.5 flex-shrink-0 mt-0.5", tone)} aria-hidden />
      <p className="text-gray-400">
        <span className="sr-only">{issue.severity}: </span>
        {issue.key && <span className={cn("font-mono mr-1", tone)}>{issue.key}</span>}
        {issue.message}
      </p>
    </div>
  );
}
