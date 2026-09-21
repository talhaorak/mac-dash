import { useEffect, useId, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Copy,
  FolderOpen,
  Pencil,
  RefreshCw,
  ScrollText,
  Trash2,
  X,
} from "lucide-react";
import { Dialog } from "@/components/ui/Dialog";
import { ConfirmButton } from "@/components/ui/ConfirmButton";
import { CopyButton } from "@/components/ui/CopyButton";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { toast } from "@/components/ui/Toast";
import { backend, type JobMeta, type JobOutput, type JobSignature, type ServiceDetail } from "@/lib/backend";
import type { ServiceInfo } from "@/stores/app";
import { cn } from "@/lib/utils";
import { scopeFor } from "@shared/launchd";
import { t, useT } from "@/i18n";
import { localizeExitStatus, localizeTriggers, scopeTitle } from "@/i18n/launchd";
import { inputClass } from "./fields";
import { JobIconPicker } from "./JobIcon";
import { JobLogTab } from "./JobLogTab";
import { authorityChain, describeSignature } from "./signature";

type Tab = "overview" | "output" | "log" | "launchctl" | "notes";

export function JobDetailDrawer({
  service,
  meta,
  onClose,
  onEdit,
  onDuplicate,
  onDelete,
  onMetaSaved,
  onNavigateToProcess,
  onViewLogs,
}: {
  service: ServiceInfo | null;
  meta: JobMeta | undefined;
  onClose: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onMetaSaved: (meta: JobMeta) => void;
  onNavigateToProcess: (pid: number) => void;
  onViewLogs: (processName: string) => void;
}) {
  const titleId = useId();
  return (
    <Dialog open={service !== null} onClose={onClose} variant="drawer" labelledBy={titleId} className="max-w-xl! glass overflow-y-auto">
      {service && (
        <DrawerBody
          key={`${service.category}/${service.label}`}
          titleId={titleId}
          service={service}
          meta={meta}
          onClose={onClose}
          onEdit={onEdit}
          onDuplicate={onDuplicate}
          onDelete={onDelete}
          onMetaSaved={onMetaSaved}
          onNavigateToProcess={onNavigateToProcess}
          onViewLogs={onViewLogs}
        />
      )}
    </Dialog>
  );
}

function DrawerBody({
  titleId,
  service,
  meta,
  onClose,
  onEdit,
  onDuplicate,
  onDelete,
  onMetaSaved,
  onNavigateToProcess,
  onViewLogs,
}: Omit<Parameters<typeof JobDetailDrawer>[0], "service"> & { titleId: string; service: ServiceInfo }) {
  useT(); // subscribe: re-render when the language changes
  const ref = { label: service.label, category: service.category };
  const [tab, setTab] = useState<Tab>("overview");
  const [detail, setDetail] = useState<ServiceDetail | null>(null);

  useEffect(() => {
    let cancelled = false;
    backend.getServiceDetail(ref).then((d) => !cancelled && setDetail(d)).catch(() => {});
    return () => {
      cancelled = true;
    };
    // Re-query when the job starts or stops.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service.label, service.category, service.pid, service.loaded]);

  const hasFile = service.plistPath !== null;

  // Code signature: asked for once, when the Overview tab shows a job that has a plist.
  // The backend reads the executable path from the plist itself.
  const [signature, setSignature] = useState<JobSignature | { failed: string } | null>(null);
  const wantSignature = tab === "overview" && hasFile && signature === null;
  useEffect(() => {
    if (!wantSignature) return;
    let cancelled = false;
    backend
      .getJobSignature({ label: service.label, category: service.category })
      .then((sig) => !cancelled && setSignature(sig))
      .catch((e: Error) => !cancelled && setSignature({ failed: e.message || t("detail.drawer.signatureReadError") }));
    return () => {
      cancelled = true;
    };
  }, [wantSignature, service.label, service.category]);

  const exitText = localizeExitStatus(service.lastExitStatus);
  const programName = service.program?.split("/").pop();

  const tabs: { id: Tab; label: string }[] = [
    { id: "overview", label: t("detail.drawer.tabOverview") },
    ...(hasFile ? [{ id: "output" as Tab, label: t("detail.drawer.tabOutput") }] : []),
    { id: "log", label: t("detail.drawer.tabLog") },
    { id: "launchctl", label: "launchctl print" },
    { id: "notes", label: `${t("detail.drawer.tabNotes")}${meta?.notes || meta?.tags.length || meta?.icon ? " •" : ""}` },
  ];

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1.5 min-w-0">
          <h2 id={titleId} className="text-lg font-bold text-white break-all">
            {service.label}
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={service.status} />
            {service.disabled && <Chip tone="amber">{t("detail.drawer.disabledChip")}</Chip>}
            {!service.loaded && !service.disabled && <Chip tone="gray">{t("detail.drawer.notLoadedChip")}</Chip>}
            {service.unreadable && <Chip tone="red">{t("detail.drawer.unreadablePlistChip")}</Chip>}
            {service.quarantined && <Chip tone="red">{t("detail.drawer.quarantinedChip")}</Chip>}
            <Chip tone="gray">{scopeTitle(service.category)}</Chip>
          </div>
        </div>
        <button type="button" aria-label={t("detail.drawer.closeDetails")} onClick={onClose} className="p-2 rounded-lg hover:bg-white/[0.06] text-gray-400">
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Actions */}
      <div className="flex flex-wrap gap-2">
        {hasFile && (
          <ActionButton icon={Pencil} onClick={onEdit}>
            {service.writable ? t("common.edit") : t("detail.drawer.viewPlist")}
          </ActionButton>
        )}
        {hasFile && (
          <ActionButton icon={Copy} onClick={onDuplicate}>
            {t("common.duplicate")}
          </ActionButton>
        )}
        {hasFile && (
          <ActionButton
            icon={FolderOpen}
            onClick={() => backend.revealJob(ref).catch((e: Error) => toast.error(e.message))}
          >
            {t("common.revealInFinder")}
          </ActionButton>
        )}
        {programName && (
          <ActionButton icon={ScrollText} onClick={() => onViewLogs(programName)}>
            {t("detail.drawer.systemLogButton")}
          </ActionButton>
        )}
        {service.pid !== null && (
          <ActionButton icon={Activity} onClick={() => onNavigateToProcess(service.pid!)}>
            {t("detail.drawer.processButton", { pid: service.pid })}
          </ActionButton>
        )}
        {service.writable && hasFile && (
          <ConfirmButton
            onConfirm={onDelete}
            confirmLabel={t("detail.drawer.confirmMoveToTrash")}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-red-400 bg-red-500/5 hover:bg-red-500/10 border border-red-500/20"
            armedClassName="bg-red-500/25! text-red-200!"
          >
            <Trash2 className="w-3.5 h-3.5" />
            {t("common.delete")}
          </ConfirmButton>
        )}
      </div>

      {service.quarantined && <Notice>{t("detail.drawer.quarantineNotice")}</Notice>}
      {service.unreadable && <Notice>{t("detail.drawer.unreadableNotice")}</Notice>}

      <div role="tablist" aria-label={t("detail.drawer.tabsAria")} className="flex flex-wrap gap-1">
        {tabs.map((tabInfo) => (
          <button
            key={tabInfo.id}
            type="button"
            role="tab"
            aria-selected={tab === tabInfo.id}
            onClick={() => setTab(tabInfo.id)}
            className={cn(
              "px-3 py-1.5 rounded-lg text-xs font-medium transition-all",
              tab === tabInfo.id ? "bg-cyan-500/15 text-cyan-400 ring-1 ring-cyan-500/30" : "text-gray-500 hover:text-gray-300 hover:bg-white/[0.04]"
            )}
          >
            {tabInfo.label}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <dl className="space-y-3">
          <Row label={t("detail.drawer.program")} value={service.program} mono />
          {service.programArguments && service.programArguments.length > 0 && (
            <Row label={t("detail.drawer.arguments")} value={service.programArguments.join("\n")} mono copyText={service.programArguments.join(" ")} />
          )}
          <Row
            label={t("detail.drawer.triggers")}
            value={service.triggers.length > 0 ? localizeTriggers(service.triggers).join(" · ") : hasFile ? t("detail.drawer.noTriggers") : null}
          />
          <Row label={t("detail.drawer.plistLabel")} value={service.plistPath} mono />
          {hasFile && <SignatureRow signature={signature} />}
          <Row label={t("detail.drawer.runsAs")} value={service.userName ?? (scopeFor(service.category)?.kind === "daemon" ? "root" : t("detail.drawer.loggedInUser"))} />
          <Row label={t("detail.drawer.launchdState")} value={detail?.state ?? (service.loaded ? "loaded" : "not loaded")} />
          <Row label={t("detail.drawer.domain")} value={detail?.domain ?? null} mono />
          <Row
            label={t("detail.drawer.lastExit")}
            value={service.lastExitStatus === null ? t("detail.drawer.neverExited") : `${service.lastExitStatus}: ${exitText}`}
            tone={service.lastExitStatus ? "red" : undefined}
          />
          <Row label={t("detail.drawer.exitReason")} value={detail?.lastExitReason ?? null} />
          <Row label={t("detail.drawer.bundleId")} value={detail?.bundleId ?? null} mono />
          {detail && Object.keys(detail.environment).length > 0 && (
            <Row label={t("detail.drawer.environment")} value={Object.entries(detail.environment).map(([k, v]) => `${k}=${v}`).join("\n")} mono />
          )}
        </dl>
      )}

      {tab === "output" && <OutputTab service={service} />}

      {tab === "log" && <JobLogTab label={service.label} program={service.program} />}

      {tab === "launchctl" &&
        (detail ? (
          <div className="relative">
            <pre className="max-h-[60vh] overflow-auto rounded-xl bg-black/40 p-3 text-[11px] font-mono text-gray-300 whitespace-pre">{detail.raw}</pre>
            <span className="absolute top-2 right-2">
              <CopyButton text={detail.raw} />
            </span>
          </div>
        ) : (
          <p className="text-sm text-gray-500">{t("detail.drawer.launchctlEmpty")}</p>
        ))}

      {tab === "notes" && <NotesTab service={service} meta={meta} onSaved={onMetaSaved} />}
    </div>
  );
}

function OutputTab({ service }: { service: ServiceInfo }) {
  const [stream, setStream] = useState<"stdout" | "stderr">("stdout");
  const [output, setOutput] = useState<JobOutput | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    backend
      .readJobOutput({ label: service.label, category: service.category }, stream, 300)
      .then((o) => !cancelled && setOutput(o))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [service.label, service.category, stream, tick]);

  // Follow the file while the job runs.
  useEffect(() => {
    if (service.status !== "running") return;
    const timer = setInterval(() => setTick((t) => t + 1), 3000);
    return () => clearInterval(timer);
  }, [service.status]);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1">
        {(["stdout", "stderr"] as const).map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={stream === s}
            onClick={() => setStream(s)}
            className={cn("px-2.5 py-1 rounded-lg text-xs", stream === s ? "bg-white/[0.08] text-gray-200" : "text-gray-500 hover:text-gray-300")}
          >
            {s === "stdout" ? t("detail.output.stdout") : t("detail.output.stderr")}
          </button>
        ))}
        <button
          type="button"
          aria-label={t("detail.output.refreshAria")}
          onClick={() => setTick((n) => n + 1)}
          className="ml-auto p-1.5 rounded-lg text-gray-500 hover:text-gray-300 hover:bg-white/[0.06]"
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>
      {output === null ? (
        <p className="text-sm text-gray-500">{t("common.loading")}</p>
      ) : output.path === null ? (
        <p className="text-sm text-gray-500">{t("detail.output.noPath", { field: stream === "stdout" ? "StandardOutPath" : "StandardErrorPath" })}</p>
      ) : !output.exists ? (
        <p className="text-sm text-gray-500">
          <span className="font-mono text-xs">{output.path}</span> {t("detail.output.notExists")}
        </p>
      ) : (
        <>
          <p className="text-[11px] text-gray-600 font-mono break-all">
            {output.path} · {output.size} B{output.truncated ? ` · ${t("detail.output.truncated")}` : ""}
          </p>
          <pre className="max-h-[55vh] overflow-auto rounded-xl bg-black/40 p-3 text-[11px] font-mono text-gray-300 whitespace-pre-wrap break-all">
            {output.text || t("detail.output.empty")}
          </pre>
        </>
      )}
    </div>
  );
}

function NotesTab({ service, meta, onSaved }: { service: ServiceInfo; meta: JobMeta | undefined; onSaved: (meta: JobMeta) => void }) {
  const [notes, setNotes] = useState(meta?.notes ?? "");
  const [tags, setTags] = useState((meta?.tags ?? []).join(", "));
  const [icon, setIcon] = useState<string | undefined>(meta?.icon || undefined);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const next: JobMeta = {
      notes: notes.trim(),
      tags: [...new Set(tags.split(/[,;\s]+/).map((t) => t.trim()).filter(Boolean))],
      // No icon means no `icon` field: the backend deletes an entry that has no notes, no tags and no icon.
      ...(icon ? { icon } : {}),
    };
    setSaving(true);
    try {
      await backend.setJobMeta({ label: service.label, category: service.category }, next);
      onSaved(next);
      toast.success(t("detail.notes.saved"));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <JobIconPicker value={icon} onChange={setIcon} label={service.label} disabled={saving} />
      <label className="block space-y-1">
        <span className="text-xs font-medium text-gray-400">{t("detail.notes.tagsLabel")}</span>
        <input type="text" value={tags} onChange={(e) => setTags(e.target.value)} placeholder={t("detail.notes.tagsPlaceholder")} className={inputClass} />
        <span className="text-[11px] text-gray-600">{t("detail.notes.tagsHint")}</span>
      </label>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-gray-400">{t("detail.notes.notesLabel")}</span>
        <textarea rows={8} value={notes} onChange={(e) => setNotes(e.target.value)} className={cn(inputClass, "resize-y")} />
        <span className="text-[11px] text-gray-600">{t("detail.notes.notesHint")}</span>
      </label>
      <button
        type="button"
        disabled={saving}
        onClick={save}
        className="px-3 py-1.5 rounded-lg text-xs font-medium text-cyan-950 bg-cyan-400 hover:bg-cyan-300 disabled:opacity-40"
      >
        {t("detail.notes.saveButton")}
      </button>
    </div>
  );
}

function Chip({ tone, children }: { tone: "amber" | "gray" | "red"; children: React.ReactNode }) {
  const tones = {
    amber: "bg-amber-500/10 text-amber-400 border-amber-500/20",
    gray: "bg-white/[0.04] text-gray-400 border-white/[0.08]",
    red: "bg-red-500/10 text-red-400 border-red-500/20",
  };
  return <span className={cn("px-2 py-0.5 rounded-full text-[10px] font-medium border", tones[tone])}>{children}</span>;
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex gap-2 rounded-xl border border-amber-500/20 bg-amber-500/5 p-3 text-xs text-amber-200/90">
      <AlertTriangle className="w-4 h-4 flex-shrink-0 text-amber-400" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

function ActionButton({ icon: Icon, onClick, children }: { icon: typeof Pencil; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-gray-300 bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06]"
    >
      <Icon className="w-3.5 h-3.5" aria-hidden />
      {children}
    </button>
  );
}

function SignatureRow({ signature }: { signature: JobSignature | { failed: string } | null }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const sig = signature && !("failed" in signature) ? signature : null;
  const summary = sig ? describeSignature(sig) : null;
  const tone = summary?.tone === "warning" ? "text-amber-400" : summary?.tone === "ok" ? "text-gray-300" : "text-gray-500";
  const hasDetails = sig !== null && (sig.authorities.length > 0 || sig.identifier !== null || sig.teamId !== null || sig.path !== null);

  return (
    <div className="grid grid-cols-[110px_1fr] gap-3">
      <dt className="text-xs text-gray-500 pt-1.5">{t("detail.drawer.signedBy")}</dt>
      <dd className="min-w-0 text-sm space-y-1.5">
        {signature === null ? (
          <span className="text-gray-500">{t("detail.drawer.checkingSignature")}</span>
        ) : "failed" in signature ? (
          <span className="text-gray-500 break-words">{signature.failed}</span>
        ) : (
          <>
            <p className={cn("flex items-start gap-1.5 break-words", tone)} title={authorityChain(signature) || undefined}>
              {summary!.tone === "warning" && <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" aria-hidden />}
              <span>
                {summary!.tone === "warning" && <span className="sr-only">{t("detail.drawer.warningPrefix")}</span>}
                {summary!.text}
              </span>
            </p>
            {hasDetails && (
              <button
                type="button"
                aria-expanded={open}
                aria-controls={listId}
                onClick={() => setOpen(!open)}
                className="inline-flex items-center gap-1 rounded-md text-[11px] text-gray-500 hover:text-gray-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/50"
              >
                {open ? <ChevronDown className="w-3 h-3" aria-hidden /> : <ChevronRight className="w-3 h-3" aria-hidden />}
                {t("detail.drawer.signatureDetailsToggle")}
              </button>
            )}
            {hasDetails && open && (
              <div id={listId} className="rounded-lg bg-black/20 px-3 py-2 space-y-1.5 text-[11px] text-gray-400">
                {signature.authorities.length > 0 && (
                  <>
                    <p className="text-gray-500">{signature.trusted ? t("detail.drawer.certChain") : t("detail.drawer.certChainUnverified")}</p>
                    <ol className="list-decimal list-inside space-y-0.5 font-mono break-words">
                      {signature.authorities.map((a, i) => (
                        <li key={i}>{a}</li>
                      ))}
                    </ol>
                  </>
                )}
                {signature.identifier && (
                  <p>
                    {t("detail.drawer.identifierLabel")} <span className="font-mono break-all">{signature.identifier}</span>
                  </p>
                )}
                {signature.teamId && (
                  <p>
                    {t("detail.drawer.teamIdLabel")} <span className="font-mono">{signature.teamId}</span>
                  </p>
                )}
                {signature.path && (
                  <p>
                    {t("detail.drawer.executableLabel")} <span className="font-mono break-all">{signature.path}</span>
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </dd>
    </div>
  );
}

function Row({
  label,
  value,
  mono,
  tone,
  copyText,
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
  tone?: "red";
  copyText?: string;
}) {
  if (!value) return null;
  return (
    <div className="grid grid-cols-[110px_1fr] gap-3 group">
      <dt className="text-xs text-gray-500 pt-1.5">{label}</dt>
      <dd
        className={cn(
          "relative text-sm break-all whitespace-pre-wrap",
          tone === "red" ? "text-red-400" : "text-gray-300",
          mono && "font-mono text-xs bg-black/20 rounded-lg px-3 py-1.5 pr-8"
        )}
      >
        {value}
        {mono && (
          <span className="absolute top-1 right-1">
            <CopyButton text={copyText ?? value} />
          </span>
        )}
      </dd>
    </div>
  );
}
